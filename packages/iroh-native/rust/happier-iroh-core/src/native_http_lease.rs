//! Guest-safe loopback origin backed by the existing signed TCP substream mux.
//! This is a wire adapter: daemon admission/open remain the authority for the
//! registered target and its HTTP policy. Neither control JSON nor the private
//! machine-listener capability is read from a guest socket.
use crate::{
    IrohEndpoint, IrohError, MachineTunnel, MachineTunnelConfig, MachineTunnelStatus, Result,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::net::{Ipv4Addr, SocketAddr};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    WebSocketStream,
};

const OPEN_PATH: &str = "/peer-mediation/v2/tunnel/open";
const STREAM_PATH: &str = "/peer-mediation/v1/tunnel/stream";

pub struct NativeHttpLease {
    local_addr: SocketAddr,
    tunnel: Option<MachineTunnel>,
    task: Option<JoinHandle<()>>,
    shutdown: watch::Sender<bool>,
    closed: watch::Receiver<()>,
}

struct MuxConfig {
    tunnel_id: String,
    initial_window: u64,
    max_frame: usize,
}

fn invalid() -> IrohError {
    IrohError::InvalidDescriptor
}

// Validate the native adapter's one-target binding before any transport work.
// Signature, freshness, registration, revocation and policy are verified by the
// canonical daemon owners, not reimplemented here.
fn parse_open(handshake_json: &str, endpoint_id: &str, open_json: &str) -> Result<Value> {
    let handshake: Value = serde_json::from_str(handshake_json).map_err(|_| invalid())?;
    let open: Value = serde_json::from_str(open_json).map_err(|_| invalid())?;
    let scope = &handshake["grant"]["payload"]["scope"];
    let preview = &scope["preview"];
    let port = open["destination"]["port"]
        .as_u64()
        .filter(|port| (1..=65535).contains(port))
        .ok_or_else(invalid)?;
    let ports = scope["allowedPorts"].as_array().ok_or_else(invalid)?;
    let tunnel_id = open["tunnelId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?;
    if handshake["flow"] != "tcp_tunnel"
        || open["v"] != 2
        || open["kind"] != "open"
        || open["routeKind"] != "iroh_peer"
        || scope["kind"] != "tcp_tunnel"
        || scope["tunnelId"] != tunnel_id
        || ports.len() != 1
        || ports[0].as_u64() != Some(port)
        || preview["previewId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .is_none()
        || preview["machineId"] != open["targetMachineId"]
        || preview["target"]["port"].as_u64() != Some(port)
        || preview["target"]["host"] != open["destination"]["host"]
        || preview["target"]["scheme"]
            .as_str()
            .filter(|scheme| matches!(*scheme, "http" | "https"))
            .is_none()
        || open["destination"]["host"]
            .as_str()
            .filter(|host| matches!(*host, "127.0.0.1" | "localhost" | "::1"))
            .is_none()
        || open["grant"].is_null()
        || open["proof"].is_null()
        || open["grant"] != handshake["grant"]
        || open["proof"] != handshake["proof"]
        || open["targetMachineId"] != handshake["target"]["machineId"]
        || handshake["target"]["endpointId"] != endpoint_id
    {
        return Err(invalid());
    }
    Ok(open)
}

async fn open_mux(
    tunnel: &MachineTunnel,
    open: &Value,
) -> Result<(WebSocketStream<TcpStream>, MuxConfig)> {
    let local_addr = tunnel.local_addr()?;
    let capability = tunnel.local_capability().ok_or_else(invalid)?;
    let body = serde_json::to_vec(open).map_err(|_| invalid())?;
    let mut socket = TcpStream::connect(local_addr)
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    socket
        .write_all(capability.as_bytes())
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    let head = format!("POST {OPEN_PATH} HTTP/1.1\r\nHost: {local_addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n", body.len());
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    socket
        .write_all(&body)
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    // Canonical daemon JSON responses serialize Content-Length. Keep this
    // carrier alive until the WS owns the existing control session; EOF before
    // attachment (including a cancelled/failed native start) releases it.
    let mut control = BufReader::new(socket);
    let mut head = String::new();
    while !head.ends_with("\r\n\r\n") {
        if control
            .read_line(&mut head)
            .await
            .map_err(|_| IrohError::TransportClosed)?
            == 0
        {
            return Err(IrohError::TransportClosed);
        }
    }
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(invalid)?;
    if status != "200" {
        return Err(IrohError::TransportClosed);
    }
    let mut length = None;
    for line in head.lines().skip(1).filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(invalid());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(invalid());
            }
            length = Some(value.trim().parse::<usize>().map_err(|_| invalid())?);
        }
    }
    let mut response = vec![0; length.ok_or_else(invalid)?];
    control
        .read_exact(&mut response)
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    let result: Value = serde_json::from_slice(&response).map_err(|_| invalid())?;
    if result["v"] != 1
        || result["tunnelId"] != open["tunnelId"]
        || result["streamPath"] != STREAM_PATH
        || result["encoding"] != "binary_frame_v2"
    {
        return Err(invalid());
    }
    // These are the Protocol open-response resource bounds, not independent
    // lease lifetime/traffic limits. A guest may keep its listener indefinitely.
    let initial_window = result["initialWindowBytes"]
        .as_u64()
        .filter(|window| (65536..=8 * 1024 * 1024).contains(window))
        .ok_or_else(invalid)?;
    let max_frame = result["maxFrameBytes"]
        .as_u64()
        .filter(|size| *size > 0 && *size <= 8 * 1024 * 1024)
        .ok_or_else(invalid)? as usize;
    // Attach the signed control session before a guest opens a substream, so
    // an idle listener participates in canonical revocation/transport cleanup.
    let tunnel_id = open["tunnelId"].as_str().ok_or_else(invalid)?;
    let mut stream_url = format!("ws://{local_addr}{STREAM_PATH}?tunnelId=");
    for byte in tunnel_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            stream_url.push(char::from(byte));
        } else {
            write!(&mut stream_url, "%{byte:02X}").map_err(|_| invalid())?;
        }
    }
    let request = stream_url.into_client_request().map_err(|_| invalid())?;
    let mut socket = TcpStream::connect(local_addr)
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    socket
        .write_all(capability.as_bytes())
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(4 + max_frame * 2))
        .max_frame_size(Some(4 + max_frame * 2));
    let (websocket, _) = client_async_with_config(request, socket, Some(config))
        .await
        .map_err(|_| IrohError::TransportClosed)?;
    drop(control);
    Ok((
        websocket,
        MuxConfig {
            tunnel_id: tunnel_id.to_owned(),
            initial_window,
            max_frame,
        },
    ))
}

fn encode(mut header: Value, payload: &[u8]) -> Result<Message> {
    header["version"] = json!(2);
    header["payloadLength"] = json!(payload.len());
    let bytes = serde_json::to_vec(&header).map_err(|_| invalid())?;
    let length = u32::try_from(bytes.len()).map_err(|_| invalid())?;
    let mut frame = Vec::with_capacity(4 + bytes.len() + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&bytes);
    frame.extend_from_slice(payload);
    Ok(Message::Binary(frame.into()))
}

fn decode(bytes: &[u8], config: &MuxConfig) -> Result<(Value, Vec<u8>)> {
    let prefix: [u8; 4] = bytes
        .get(..4)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > config.max_frame || bytes.len() < 4 + length {
        return Err(invalid());
    }
    let header: Value = serde_json::from_slice(&bytes[4..4 + length]).map_err(|_| invalid())?;
    let payload = &bytes[4 + length..];
    let fields = header.as_object().ok_or_else(invalid)?;
    if fields.keys().any(|field| {
        !matches!(
            field.as_str(),
            "version"
                | "kind"
                | "tunnelId"
                | "substreamId"
                | "direction"
                | "sequence"
                | "ack"
                | "window"
                | "halfClose"
                | "reasonCode"
                | "flags"
                | "receiptId"
                | "payloadLength"
        )
    }) || header["version"] != 2
        || header["tunnelId"] != config.tunnel_id
        || header["payloadLength"].as_u64() != Some(payload.len() as u64)
        || payload.len() > config.max_frame
    {
        return Err(invalid());
    }
    Ok((header, payload.to_vec()))
}

async fn send(outgoing: &mpsc::Sender<Message>, header: Value, payload: &[u8]) -> Result<()> {
    outgoing
        .send(encode(header, payload)?)
        .await
        .map_err(|_| IrohError::TransportClosed)
}

type Incoming = (Value, Vec<u8>);

async fn pump_guest(
    mut socket: TcpStream,
    mut incoming: mpsc::Receiver<Incoming>,
    outgoing: mpsc::Sender<Message>,
    tunnel_id: String,
    substream_id: String,
    initial_window: u64,
    max_frame: usize,
) -> Result<()> {
    let base = json!({"tunnelId": tunnel_id, "substreamId": substream_id});
    let mut sequence = 0u64;
    let mut acknowledged = 0u64;
    let mut send_window = initial_window;
    let mut received = 0u64;
    let mut read_closed = false;
    let mut write_closed = false;
    let mut buffer = vec![0u8; max_frame.min(initial_window as usize)];
    send(
        &outgoing,
        json!({"kind":"open", "tunnelId": tunnel_id, "substreamId": substream_id}),
        &[],
    )
    .await?;
    loop {
        if read_closed && write_closed {
            return Ok(());
        }
        let available = acknowledged
            .saturating_add(send_window)
            .saturating_sub(sequence);
        let capacity = buffer.len().min(available as usize);
        tokio::select! {
            read = socket.read(&mut buffer[..capacity]), if !read_closed && capacity > 0 => {
                let count = read.map_err(|_| IrohError::TransportClosed)?;
                let mut header = base.clone();
                header["direction"] = json!("client_to_daemon");
                if count == 0 {
                    read_closed = true;
                    header["kind"] = json!("close"); header["halfClose"] = json!(true); header["reasonCode"] = json!("local_eof");
                } else { header["kind"] = json!("data"); header["sequence"] = json!(sequence); sequence += count as u64; }
                send(&outgoing, header, &buffer[..count]).await?;
            }
            frame = incoming.recv() => {
                let Some((header, payload)) = frame else { return Err(IrohError::TransportClosed) };
                match header["kind"].as_str() {
                    Some("data") if !write_closed && header["direction"] == "daemon_to_client" && header["sequence"].as_u64() == Some(received) && payload.len() as u64 <= initial_window => {
                        socket.write_all(&payload).await.map_err(|_| IrohError::TransportClosed)?;
                        received += payload.len() as u64;
                        // Credit is returned only after the OS socket accepted these bytes.
                        send(&outgoing, json!({"kind":"ack", "tunnelId":tunnel_id, "substreamId":substream_id, "direction":"daemon_to_client", "ack":received, "window":initial_window}), &[]).await?;
                    }
                    Some("ack") if payload.is_empty() && header["direction"] == "client_to_daemon" => {
                        let ack = header["ack"].as_u64().filter(|ack| *ack >= acknowledged && *ack <= sequence).ok_or_else(invalid)?;
                        let window = header["window"].as_u64().filter(|window| *window <= initial_window).ok_or_else(invalid)?;
                        acknowledged = ack; send_window = window;
                    }
                    Some("close") if payload.is_empty() => {
                        if header["halfClose"] == true && header["direction"] == "daemon_to_client" {
                            write_closed = true;
                            socket.shutdown().await.map_err(|_| IrohError::TransportClosed)?;
                        } else { return Ok(()); }
                    }
                    Some("abort") if payload.is_empty() => return Err(IrohError::TransportClosed),
                    _ => return Err(invalid()),
                }
            }
        }
    }
}

async fn serve(
    listener: TcpListener,
    websocket: WebSocketStream<TcpStream>,
    config: MuxConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let (mut sink, mut source) = websocket.split();
    // One pending frame per writer provides socket backpressure; the negotiated
    // mux window remains the resource authority. There is no traffic/lifetime cap.
    let (outgoing, mut frames) = mpsc::channel(1);
    let mut writer = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if sink.send(frame).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let mut streams = JoinSet::new();
    let mut incoming: HashMap<String, mpsc::Sender<Incoming>> = HashMap::new();
    let mut next_id = 0u64;
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = &mut writer => break,
            socket = listener.accept() => {
                let Ok((socket, _)) = socket else { break };
                next_id += 1;
                let id = format!("native_http_{next_id}");
                let (sender, receiver) = mpsc::channel(1);
                incoming.insert(id.clone(), sender);
                let outgoing = outgoing.clone();
                let tunnel_id = config.tunnel_id.clone();
                let (window, frame_size) = (config.initial_window, config.max_frame);
                streams.spawn(async move {
                    let result = pump_guest(socket, receiver, outgoing.clone(), tunnel_id.clone(), id.clone(), window, frame_size).await;
                    if result.is_err() { let _ = send(&outgoing, json!({"kind":"abort", "tunnelId":tunnel_id, "substreamId":id, "reasonCode":"native_guest_closed"}), &[]).await; }
                    id
                });
            }
            frame = source.next() => {
                match frame {
                    Some(Ok(Message::Binary(bytes))) => {
                        let Ok((header, payload)) = decode(&bytes, &config) else { break };
                        let Some(id) = header["substreamId"].as_str().map(str::to_owned) else { break };
                        if let Some(sender) = incoming.get(&id) {
                            // The writer runs independently, so a slow guest cannot
                            // deadlock credit delivery while this inlet backpressures.
                            tokio::select! {
                                _ = shutdown.changed() => break,
                                _ = &mut writer => break,
                                result = sender.send((header, payload)) => { if result.is_err() { incoming.remove(&id); } }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => { if outgoing.send(Message::Pong(bytes)).await.is_err() { break; } }
                    Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
            Some(done) = streams.join_next(), if !streams.is_empty() => {
                if let Ok(id) = done { incoming.remove(&id); }
            }
        }
    }
    writer.abort();
    streams.shutdown().await;
}

impl NativeHttpLease {
    pub async fn start(
        endpoint: &IrohEndpoint,
        config: MachineTunnelConfig,
        open_json: &str,
    ) -> Result<Self> {
        let open = parse_open(&config.handshake_json, &config.endpoint_id, open_json)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let local_addr = listener
            .local_addr()
            .map_err(|_| IrohError::LoopbackBindFailed)?;
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (finished, closed) = watch::channel(());
        let mut lease = Self {
            local_addr,
            tunnel: Some(MachineTunnel::start(endpoint, config).await?),
            task: None,
            shutdown,
            closed,
        };
        let (websocket, config) =
            open_mux(lease.tunnel.as_ref().expect("owned inner tunnel"), &open).await?;
        lease.task = Some(tokio::spawn(async move {
            // Dropping the sole sender also notifies waiters on task abort or panic.
            let _finished = finished;
            serve(listener, websocket, config, shutdown_rx).await;
        }));
        Ok(lease)
    }
    pub fn closed_signal(&self) -> watch::Receiver<()> {
        self.closed.clone()
    }
    pub fn status(&self) -> MachineTunnelStatus {
        let mut status = self.tunnel.as_ref().expect("owned inner tunnel").status();
        status.local_port = self.local_addr.port();
        status.connection_active &= self.closed.has_changed().is_ok();
        status
    }
    pub async fn stop_and_wait(mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        if let Some(tunnel) = self.tunnel.take() {
            tunnel.stop_and_wait().await;
        }
    }
}
impl Drop for NativeHttpLease {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if let Some(tunnel) = self.tunnel.take() {
            tunnel.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EndpointConfig, IrohCapProfile, MachineAcceptor, MachineAcceptorConfig, RelayPolicy,
        IROH_MACHINE_APPLICATION_PORT_HEADER, IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
    };
    use tokio_tungstenite::{
        accept_async, accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    fn fixture() -> (Value, Value) {
        let grant = json!({"payload":{"exp":null,"scope":{"kind":"tcp_tunnel","tunnelId":"preview-tunnel","allowedPorts":[3000],"preview":{"previewId":"preview-1","machineId":"machine-1","owner":{"kind":"session","id":"session-1"},"target":{"scheme":"http","host":"127.0.0.1","port":3000}}}}});
        let proof = json!({"kind":"ephemeral_ed25519"});
        let handshake = json!({"v":1,"flow":"tcp_tunnel","target":{"machineId":"machine-1","endpointId":"endpoint-1"},"grant":grant,"proof":proof});
        let open = json!({"v":2,"kind":"open","routeKind":"iroh_peer","targetMachineId":"machine-1","tunnelId":"preview-tunnel","destination":{"host":"127.0.0.1","port":3000},"grant":grant,"proof":proof});
        (handshake, open)
    }

    #[test]
    fn guest_lease_requires_the_registered_preview_binding() {
        let (mut handshake, mut open) = fixture();
        assert!(parse_open(&handshake.to_string(), "endpoint-1", &open.to_string()).is_ok());
        handshake["grant"]["payload"]["scope"]
            .as_object_mut()
            .unwrap()
            .remove("preview");
        open["grant"] = handshake["grant"].clone();
        assert!(parse_open(&handshake.to_string(), "endpoint-1", &open.to_string()).is_err());
    }

    #[test]
    fn guest_lease_rejects_preview_target_drift_and_wider_port_authority() {
        let (handshake, open) = fixture();
        for (field, value) in [("host", json!("localhost")), ("port", json!(3001))] {
            let mut changed_handshake = handshake.clone();
            let mut changed_open = open.clone();
            changed_handshake["grant"]["payload"]["scope"]["preview"]["target"][field] = value;
            changed_open["grant"] = changed_handshake["grant"].clone();
            assert!(parse_open(
                &changed_handshake.to_string(),
                "endpoint-1",
                &changed_open.to_string()
            )
            .is_err());
        }
        let mut changed_handshake = handshake.clone();
        let mut changed_open = open.clone();
        changed_handshake["grant"]["payload"]["scope"]["allowedPorts"] = json!([3000, 3001]);
        changed_open["grant"] = changed_handshake["grant"].clone();
        assert!(parse_open(
            &changed_handshake.to_string(),
            "endpoint-1",
            &changed_open.to_string()
        )
        .is_err());
        assert!(parse_open(&handshake.to_string(), "wrong-endpoint", &open.to_string()).is_err());
        let mut changed_open = open.clone();
        changed_open["proof"] = json!({"kind":"different-proof"});
        assert!(parse_open(
            &handshake.to_string(),
            "endpoint-1",
            &changed_open.to_string()
        )
        .is_err());
    }

    async fn read_head(socket: &mut TcpStream) -> Vec<u8> {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(socket.read_u8().await.unwrap());
        }
        head
    }

    async fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
        let head = String::from_utf8(read_head(socket).await).unwrap();
        let length = head
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        (head, body)
    }

    // The remote daemon is a genuine process/network boundary for the native
    // core. This fixture implements its pinned open/binary mux wire and dials
    // one real HTTP/WebSocket application. The composed CLI suite separately
    // exercises the actual daemon signature/registration/policy owners.
    async fn mux_fixture(listener: TcpListener, target: SocketAddr, expected_open: Value) {
        let (mut control, _) = listener.accept().await.unwrap();
        let (head, body) = read_request(&mut control).await;
        assert!(head.starts_with(&format!("POST {OPEN_PATH} HTTP/1.1\r\n")));
        assert!(head
            .to_ascii_lowercase()
            .contains("connection: keep-alive\r\n"));
        assert!(!head
            .to_ascii_lowercase()
            .contains(&IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER.to_ascii_lowercase()));
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            expected_open
        );
        let tunnel_id = expected_open["tunnelId"].as_str().unwrap().to_owned();
        let response = json!({"v":1,"tunnelId":tunnel_id,"streamPath":STREAM_PATH,"encoding":"binary_frame_v2","initialWindowBytes":65536,"maxFrameBytes":16384}).to_string();
        control
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{response}",
                    response.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let accept = accept_hdr_async(socket, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), STREAM_PATH);
            assert_eq!(
                request.uri().query(),
                Some("tunnelId=preview%20tunnel%2F%3F%23%C3%BC")
            );
            assert!(!request
                .headers()
                .contains_key(IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER));
            Ok(response)
        });
        let websocket = tokio::select! {
            biased;
            result = accept => result.unwrap(),
            _ = control.read_u8() => panic!("native relinquished pending control before WS attachment"),
        };
        assert!(control.read_u8().await.is_err());
        let (mut sink, mut source) = websocket.split();
        let (sender, mut receiver) = mpsc::channel::<Message>(1);
        let writer = tokio::spawn(async move {
            while let Some(frame) = receiver.recv().await {
                if sink.send(frame).await.is_err() {
                    break;
                }
            }
        });
        let mut readers = JoinSet::new();
        let mut sockets = HashMap::new();
        let config = MuxConfig {
            tunnel_id: tunnel_id.clone(),
            initial_window: 65536,
            max_frame: 16384,
        };
        while let Some(Ok(message)) = source.next().await {
            let Message::Binary(bytes) = message else {
                break;
            };
            let (header, payload) = decode(&bytes, &config).unwrap();
            let id = header["substreamId"].as_str().unwrap().to_owned();
            match header["kind"].as_str().unwrap() {
                "open" => {
                    let socket = TcpStream::connect(target).await.unwrap();
                    let (mut read, write) = socket.into_split();
                    sockets.insert(id.clone(), write);
                    let sender = sender.clone();
                    let tunnel_id = tunnel_id.clone();
                    readers.spawn(async move {
                        let mut buffer = vec![0u8; 16384]; let mut sequence = 0;
                        loop {
                            let count = read.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                let _ = send(&sender, json!({"kind":"close","tunnelId":tunnel_id,"substreamId":id,"direction":"daemon_to_client","halfClose":true,"reasonCode":"upstream_eof"}), &[]).await;
                                break;
                            }
                            if send(&sender, json!({"kind":"data","tunnelId":tunnel_id,"substreamId":id,"direction":"daemon_to_client","sequence":sequence}), &buffer[..count]).await.is_err() { break; }
                            sequence += count;
                        }
                    });
                }
                "data" => {
                    sockets
                        .get_mut(&id)
                        .unwrap()
                        .write_all(&payload)
                        .await
                        .unwrap();
                    send(&sender, json!({"kind":"ack","tunnelId":tunnel_id,"substreamId":id,"direction":"client_to_daemon","ack":header["sequence"].as_u64().unwrap()+payload.len() as u64,"window":65536}), &[]).await.unwrap();
                }
                "close" => {
                    if let Some(socket) = sockets.get_mut(&id) {
                        socket.shutdown().await.unwrap();
                    }
                }
                "abort" => {
                    sockets.remove(&id);
                }
                "ack" => {}
                kind => panic!("unexpected frame {kind}"),
            }
        }
        writer.abort();
        readers.shutdown().await;
    }

    #[tokio::test]
    async fn guest_http_and_websocket_bytes_use_the_native_machine_mux_and_release() {
        exercise_guest_lease(false).await;
    }

    #[tokio::test]
    async fn guest_lease_completion_observes_terminal_mux_loss_before_explicit_release() {
        exercise_guest_lease(true).await;
    }

    async fn exercise_guest_lease(terminal_mux: bool) {
        let mut fixtures = JoinSet::new();
        let application = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let target = application.local_addr().unwrap();
        fixtures.spawn(async move {
            let (mut http, _) = application.accept().await.unwrap();
            let head = String::from_utf8(read_head(&mut http).await).unwrap();
            assert!(head.starts_with("GET /preview HTTP/1.1\r\n"));
            assert!(!head.contains("Happier"));
            http.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            )
            .await
            .unwrap();
            drop(http);
            let (socket, _) = application.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let data = ws.next().await.unwrap().unwrap();
            assert!(matches!(data, Message::Binary(_)));
            ws.send(data).await.unwrap();
            // Keep HMR active until releasing the native lease closes it.
            let _ = ws.next().await;
        });
        let server = IrohEndpoint::bind(&EndpointConfig {
            relay_policy: RelayPolicy::Disabled,
            caps: IrohCapProfile::MachineBulk,
            ..EndpointConfig::default()
        })
        .await
        .unwrap();
        let client = IrohEndpoint::bind(&EndpointConfig {
            relay_policy: RelayPolicy::Disabled,
            caps: IrohCapProfile::MachineBulk,
            ..EndpointConfig::default()
        })
        .await
        .unwrap();
        let mut address = None;
        for _ in 0..100 {
            address = server.endpoint().addr().ip_addrs().next().copied();
            if address.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let (mut handshake, mut open) = fixture();
        // The idle WS transport must attach the exact signed id before any
        // guest frame, including ids requiring URI query encoding.
        handshake["grant"]["payload"]["scope"]["tunnelId"] = json!("preview tunnel/?#ü");
        open["tunnelId"] = json!("preview tunnel/?#ü");
        handshake["target"]["endpointId"] = json!(server.endpoint().id().to_string());
        handshake["grant"]["payload"]["scope"]["preview"]["target"]["port"] = json!(target.port());
        handshake["grant"]["payload"]["scope"]["allowedPorts"] = json!([target.port()]);
        open["grant"] = handshake["grant"].clone();
        open["destination"]["port"] = json!(target.port());
        let mux = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let mux_port = mux.local_addr().unwrap().port();
        fixtures.spawn(mux_fixture(mux, target, open.clone()));
        let admission = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let admission_target = admission.local_addr().unwrap();
        let expected_remote = client.endpoint().id().to_string();
        fixtures.spawn(async move {
            while let Ok((mut socket,_)) = admission.accept().await {
                let (head, _) = read_request(&mut socket).await;
                assert!(head.contains(&expected_remote));
                socket.write_all(format!("HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_remote}\r\n{IROH_MACHINE_APPLICATION_PORT_HEADER}: {mux_port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let acceptor =
            MachineAcceptor::start(&server, MachineAcceptorConfig { admission_target }).unwrap();
        let lease = NativeHttpLease::start(
            &client,
            MachineTunnelConfig {
                endpoint_id: server.endpoint().id().to_string(),
                bind_addr: "127.0.0.1:0".parse().unwrap(),
                direct_addresses: vec![address.unwrap()],
                relay_urls: vec![],
                handshake_json: handshake.to_string(),
                cap_profile: IrohCapProfile::MachineBulk,
            },
            &open.to_string(),
        )
        .await
        .unwrap();
        let guest_addr = lease.local_addr;
        let mut http = TcpStream::connect(guest_addr).await.unwrap();
        http.write_all(b"GET /preview HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        http.read_to_end(&mut response).await.unwrap();
        assert!(response.ends_with(b"\r\n\r\nhello"));
        drop(http);
        let socket = TcpStream::connect(guest_addr).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(format!("ws://{guest_addr}/hmr"), socket)
            .await
            .unwrap();
        let payload: Vec<u8> = (0..131072).map(|index| (index % 251) as u8).collect();
        ws.send(Message::Binary(payload.clone().into()))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_data().as_ref(),
            payload.as_slice()
        );
        let mut closed = lease.closed_signal();
        assert!(closed.has_changed().is_ok());
        if terminal_mux {
            server.endpoint().close().await;
            tokio::time::timeout(std::time::Duration::from_secs(10), closed.changed())
                .await.expect("terminal mux must finish the guest listener").unwrap_err();
            assert!(!lease.status().connection_active);
        }
        lease.stop_and_wait().await;
        assert!(closed.changed().await.is_err());
        assert!(TcpStream::connect(guest_addr).await.is_err());
        assert!(!matches!(ws.next().await, Some(Ok(Message::Binary(_)))));
        acceptor.stop_and_wait().await;
        client.endpoint().close().await;
        server.endpoint().close().await;
        fixtures.shutdown().await;
    }
}
