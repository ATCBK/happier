use crate::{IrohError, Result};

// noq-proto 1.2.0 defaults. Its TransportConfig documentation defines
// worst-case stream receive memory as stream fan-out × per-stream window, while
// the default aggregate receive window is VarInt::MAX. Use that documented
// finite structural boundary for the aggregate window instead of inventing a
// separate Home/Machine tuning value. The owner test below pins these inputs to
// the dependency's actual defaults so an upstream change requires review.
const PINNED_UPSTREAM_MAX_BIDI_STREAMS: usize = 100;
const PINNED_UPSTREAM_STREAM_RECEIVE_WINDOW: usize = 1_250_000;
const FINITE_CONNECTION_RECEIVE_WINDOW: usize =
    PINNED_UPSTREAM_MAX_BIDI_STREAMS * PINNED_UPSTREAM_STREAM_RECEIVE_WINDOW;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohCapProfile {
    HomeInteractive,
    MachineBulk,
}

impl IrohCapProfile {
    /// Both profile labels build the same transport config today. They preserve
    /// the entry-point contract at native/WASM boundaries; a measured need for
    /// different Home-interactive and machine-bulk windows is the condition for
    /// making their transport configuration diverge.
    ///
    /// Bounds connection receive memory while retaining Iroh's transport
    /// liveness defaults. Its keepalives preserve healthy application-idle
    /// streams; its idle timeout closes dead peers even when a process exits
    /// without sending a QUIC close. Disabling it leaves raw workspace streams
    /// and their engine flushes waiting forever after peer retirement.
    pub fn transport_config(self) -> Result<iroh::endpoint::QuicTransportConfig> {
        let builder = iroh::endpoint::QuicTransportConfig::builder().receive_window(
            iroh::endpoint::VarInt::from(
                u32::try_from(FINITE_CONNECTION_RECEIVE_WINDOW)
                    .map_err(|_| IrohError::ResourceLimit)?,
            ),
        );
        Ok(builder.build())
    }
}

/// Canonical string identifier for a cap profile (native binding surface).
impl IrohCapProfile {
    pub const fn id(self) -> &'static str {
        match self {
            Self::HomeInteractive => "homeInteractive",
            Self::MachineBulk => "machineBulk",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "homeInteractive" => Ok(Self::HomeInteractive),
            "machineBulk" => Ok(Self::MachineBulk),
            _ => Err(IrohError::ResourceLimit),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads one field out of a `QuicTransportConfig`'s debug rendering. The
    /// built config exposes no getters, so this is the only way to observe what
    /// the profile actually applied at the QUIC boundary rather than what the
    /// profile struct says.
    fn transport_field(rendered: &str, field: &str) -> String {
        let needle = format!(" {field}: ");
        let start = rendered
            .find(&needle)
            .unwrap_or_else(|| panic!("transport config debug must contain `{field}`"))
            + needle.len();
        let mut depth = 0usize;
        for (offset, character) in rendered[start..].char_indices() {
            match character {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' if depth > 0 => depth -= 1,
                ',' if depth == 0 => return rendered[start..start + offset].to_string(),
                _ => {}
            }
        }
        rendered[start..].to_string()
    }

    fn rendered_transport_config(profile: IrohCapProfile) -> String {
        format!(
            "{:?}",
            profile
                .transport_config()
                .expect("profile builds a QUIC transport config")
        )
    }

    /// Both profiles bound the upstream effectively-unbounded receive window,
    /// leave upstream stream/fan-out and transport liveness defaults alone.
    #[test]
    fn profiles_bound_only_real_per_connection_resources() {
        let pinned = format!("{:?}", iroh::endpoint::QuicTransportConfig::default());
        let pinned_max_streams = transport_field(&pinned, "max_concurrent_bidi_streams");
        let pinned_stream_window = transport_field(&pinned, "stream_receive_window");
        let finite_receive_window = pinned_max_streams
            .parse::<usize>()
            .expect("pinned stream fan-out is an integer")
            .checked_mul(
                pinned_stream_window
                    .parse::<usize>()
                    .expect("pinned stream window is an integer"),
            )
            .expect("pinned receive-credit product fits usize");
        assert_eq!(
            pinned_max_streams,
            PINNED_UPSTREAM_MAX_BIDI_STREAMS.to_string(),
            "review the finite connection boundary when the pinned transport fan-out changes",
        );
        assert_eq!(
            pinned_stream_window,
            PINNED_UPSTREAM_STREAM_RECEIVE_WINDOW.to_string(),
            "review the finite connection boundary when the pinned stream window changes",
        );
        assert_eq!(FINITE_CONNECTION_RECEIVE_WINDOW, finite_receive_window);
        for profile in [IrohCapProfile::HomeInteractive, IrohCapProfile::MachineBulk] {
            let rendered = rendered_transport_config(profile);
            assert_eq!(
                transport_field(&rendered, "max_concurrent_bidi_streams"),
                pinned_max_streams,
                "{} must keep the pinned upstream stream fan-out",
                profile.id(),
            );
            assert_eq!(
                transport_field(&rendered, "receive_window"),
                finite_receive_window.to_string(),
                "{} must carry a finite receive-memory boundary",
                profile.id(),
            );
            // Per-stream flow control already has a finite pinned upstream
            // default; no Home/Machine measurement supports overriding it.
            assert_eq!(
                transport_field(&rendered, "stream_receive_window"),
                pinned_stream_window,
                "{} must keep the pinned upstream per-stream window",
                profile.id(),
            );
            // QUIC keepalives preserve healthy application-idle streams while
            // the dependency's idle timeout detects a dead peer/path.
            for field in ["max_idle_timeout", "keep_alive_interval"] {
                let upstream = transport_field(&pinned, field);
                assert_ne!(upstream, "None", "the pinned transport must own liveness");
                assert_eq!(
                    transport_field(&rendered, field),
                    upstream,
                    "{} must retain upstream {field}",
                    profile.id(),
                );
            }
        }
    }

    #[test]
    fn machine_bulk_is_the_only_machine_transport_profile() {
        assert!(IrohCapProfile::parse("homeInteractive").is_ok());
        assert!(IrohCapProfile::parse("machineBulk").is_ok());
        assert!(IrohCapProfile::parse("workspaceSync").is_err());
        assert_eq!(IrohCapProfile::HomeInteractive.id(), "homeInteractive");
        assert_eq!(IrohCapProfile::MachineBulk.id(), "machineBulk");
        assert!(IrohCapProfile::parse("unlimited").is_err());
    }
}
