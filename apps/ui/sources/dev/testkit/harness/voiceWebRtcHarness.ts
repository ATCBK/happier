import { vi } from 'vitest';
import { createWebMicSession } from '@/voice/runtime/mic/WebMicSession.web';
import type { CreateMicSessionOptions, MicSession } from '@/voice/runtime/mic/MicSession';

/** Physical browser Web Audio boundary; capture and scheduling policy stay in their real owners. */
export class TestVoiceAudioContext {
    currentTime = 0;
    readonly sampleRate = 24_000;
    readonly state: AudioContextState = 'running';
    readonly destination = {};
    readonly close = vi.fn(async () => {});
    readonly gain = { value: 1, setTargetAtTime: vi.fn() };
    readonly disconnectGain = vi.fn();
    readonly processor = {
        // Browser dispatch owns the DOM receiver; this fixture invokes only the callback.
        onaudioprocess: null as OmitThisParameter<NonNullable<ScriptProcessorNode['onaudioprocess']>> | null,
        connect: vi.fn(), disconnect: vi.fn(),
    };
    readonly captureSource = { connect: vi.fn(), disconnect: vi.fn() };
    readonly sources: Array<{
        buffer: { samples: Float32Array } | null;
        onended: (() => void) | null;
        start: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        connect: ReturnType<typeof vi.fn>;
    }> = [];
    readonly createMediaStreamSource = vi.fn((_stream: MediaStream) => this.captureSource);
    readonly createScriptProcessor = vi.fn(() => this.processor);
    readonly createGain = vi.fn(() => ({ gain: this.gain, connect: vi.fn(), disconnect: this.disconnectGain }));
    readonly createBuffer = vi.fn((_channels: number, length: number) => {
        const samples = new Float32Array(length);
        return { samples, getChannelData: () => samples };
    });
    readonly createBufferSource = vi.fn(() => {
        const source = { buffer: null, onended: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn() };
        this.sources.push(source);
        return source;
    });
    emitInput(samples: Float32Array): void {
        // Native browser callback supplies the complete AudioProcessingEvent.
        // This boundary needs only the input buffer fields consumed by capture.
        this.processor.onaudioprocess?.({
            inputBuffer: { sampleRate: this.sampleRate, numberOfChannels: 1, getChannelData: () => samples },
        } as unknown as AudioProcessingEvent);
    }
}

export class TestVoiceWebRtcDataChannel extends EventTarget {
    readyState: RTCDataChannelState = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    readonly sent: string[] = [];

    send(value: string): void {
        this.sent.push(value);
        this.bufferedAmount += new TextEncoder().encode(value).byteLength;
    }

    drainTo(bufferedAmount: number): void {
        const previous = this.bufferedAmount;
        this.bufferedAmount = bufferedAmount;
        if (previous > this.bufferedAmountLowThreshold && bufferedAmount <= this.bufferedAmountLowThreshold) {
            this.dispatchEvent(new Event('bufferedamountlow'));
        }
    }

    open(): void {
        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
    }

    message(value: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: value }));
    }

    close(): void {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
    }
}

export class TestVoiceWebRtcPeer extends EventTarget {
    readonly channel = new TestVoiceWebRtcDataChannel();
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    readonly addTrack = vi.fn();
    readonly createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
    // Use the Promise API consumed by the host, not the deprecated callback overload.
    readonly createOffer = vi.fn<(options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>>(async () => ({
        type: 'offer' as const,
        sdp: 'v=0\r\na=test-offer\r\n',
    }));
    readonly setLocalDescription = vi.fn<RTCPeerConnection['setLocalDescription']>(async () => {});
    readonly setRemoteDescription = vi.fn<RTCPeerConnection['setRemoteDescription']>(async () => {});
    readonly close = vi.fn(() => {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.channel.close();
    });

    remoteTrack(track: MediaStreamTrack, streams: readonly MediaStream[] = []): void {
        const event = new Event('track');
        Object.defineProperties(event, {
            track: { value: track },
            streams: { value: streams },
        });
        this.dispatchEvent(event);
    }
}

class TestVoiceMicTrack extends EventTarget {
    readonly kind = 'audio';
    enabled = true;
    muted = false;
    private state: MediaStreamTrackState = 'live';
    constructor(readonly id: string) { super(); }
    get readyState(): MediaStreamTrackState { return this.state; }
    // MediaStreamTrack.stop ends the track but does not dispatch `ended`.
    readonly stop = vi.fn(() => { this.state = 'ended'; });
    override dispatchEvent(event: Event): boolean {
        if (event.type === 'ended') this.state = 'ended';
        return super.dispatchEvent(event);
    }
}

type VoiceBrowserCapture = Readonly<{ stream: MediaStream; track: MediaStreamTrack }>;

export function installVoiceWebRtcBrowserBoundary(input: Readonly<{
    createAudioContext?: () => AudioContext | null;
    /** Observe/configure the actual just-constructed physical SDK peer. */
    onCreatePeer?: (peer: TestVoiceWebRtcPeer) => void;
}> = {}): Readonly<{
    peer: TestVoiceWebRtcPeer;
    micStream: MediaStream;
    micTrack: MediaStreamTrack;
    micSession: MicSession;
    peers: readonly TestVoiceWebRtcPeer[];
    micTracks: readonly MediaStreamTrack[];
    micStreams: readonly MediaStream[];
    captures: readonly VoiceBrowserCapture[];
    /** Physical leaf for a getUserMedia fixture that holds its eventual reply. */
    allocateCapture(): VoiceBrowserCapture;
    createMicSession(options?: CreateMicSessionOptions): MicSession;
    restore(): void;
}> {
    const peers: TestVoiceWebRtcPeer[] = [];
    const captures: VoiceBrowserCapture[] = [];
    const micTracks: MediaStreamTrack[] = [];
    const micStreams: MediaStream[] = [];
    const allocateCapture = (): VoiceBrowserCapture => {
        // Only the browser SDK shape is supplied here; acquisition, mute and
        // retirement decisions remain in the real WebMicSession owner.
        const track = new TestVoiceMicTrack(`test-mic-track-${captures.length + 1}`) as unknown as MediaStreamTrack;
        const stream = Object.freeze({
            id: `test-mic-stream-${captures.length + 1}`,
            get active() { return track.readyState === 'live'; },
            getAudioTracks: () => [track],
            getTracks: () => [track],
        }) as unknown as MediaStream;
        const capture = Object.freeze({ stream, track });
        captures.push(capture);
        micTracks.push(track);
        micStreams.push(stream);
        return capture;
    };
    const mediaDevices = Object.assign(new EventTarget(), {
        getUserMedia: vi.fn(async () => allocateCapture().stream),
        enumerateDevices: vi.fn(async () => [{
            deviceId: 'test-mic',
            groupId: 'test',
            kind: 'audioinput' as const,
            label: 'Test microphone',
            toJSON: () => ({}),
        }]),
    }) as unknown as MediaDevices;
    const currentNavigator = globalThis.navigator;
    const previousMediaDevices = currentNavigator
        ? Object.getOwnPropertyDescriptor(currentNavigator, 'mediaDevices')
        : undefined;
    const language = typeof currentNavigator?.language === 'string'
        ? currentNavigator.language
        : 'en-US';
    const languages = Array.isArray(currentNavigator?.languages)
        ? [...currentNavigator.languages]
        : [language];

    vi.stubGlobal('RTCPeerConnection', vi.fn(() => {
        const peer = new TestVoiceWebRtcPeer();
        peers.push(peer);
        input.onCreatePeer?.(peer);
        return peer;
    }));
    if (currentNavigator) {
        // Keep the genuine Navigator's IDL brand and unrelated SDK capabilities
        // (including locks); this fixture replaces only the media device port.
        Object.defineProperty(currentNavigator, 'mediaDevices', {
            configurable: true,
            enumerable: previousMediaDevices?.enumerable ?? true,
            value: mediaDevices,
        });
    } else {
        vi.stubGlobal('navigator', { mediaDevices, language, languages });
    }
    const documentBoundary = Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
    const createObservedMicSession = (options: CreateMicSessionOptions = {}): MicSession => {
        const session = createWebMicSession({
            ...options,
            mediaDevices,
            getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
            document: documentBoundary,
            // This transport harness has no physical Web Audio device. Acquisition,
            // mute, listeners and late-stream invalidation remain the real owner.
            createAudioContext: input.createAudioContext ?? (() => null),
        });
        vi.spyOn(session, 'ensureActive');
        vi.spyOn(session, 'teardown');
        vi.spyOn(session, 'setMuted');
        return session;
    };
    let micSession = createObservedMicSession();
    const createMicSession = (options: CreateMicSessionOptions = {}): MicSession => {
        micSession = createObservedMicSession(options);
        return micSession;
    };

    return Object.freeze({
        get peer() {
            const peer = peers.at(-1);
            if (!peer) throw new Error('No browser peer has been constructed');
            return peer;
        },
        get micStream() {
            const stream = micStreams.at(-1);
            if (!stream) throw new Error('No browser microphone stream has been acquired');
            return stream;
        },
        get micTrack() {
            const track = micTracks.at(-1);
            if (!track) throw new Error('No browser microphone track has been acquired');
            return track;
        },
        peers, captures, micTracks, micStreams, allocateCapture,
        get micSession() { return micSession; },
        createMicSession,
        restore() {
            if (currentNavigator) {
                if (previousMediaDevices) Object.defineProperty(currentNavigator, 'mediaDevices', previousMediaDevices);
                else Reflect.deleteProperty(currentNavigator, 'mediaDevices');
            }
            vi.unstubAllGlobals();
        },
    });
}
