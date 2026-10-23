import { vi } from 'vitest';
import { createDeferred, type Deferred } from '../hooks/createDeferred';
import { createWebMicSession } from '@/voice/runtime/mic/WebMicSession.web';
import type { CreateMicSessionOptions, MicSession } from '@/voice/runtime/mic/MicSession';

/** Physical browser Web Audio boundary; capture and scheduling policy stay in their real owners. */
export class TestVoiceAudioContext {
    private readonly processorCreatedEvent = createDeferred<void>();
    private readonly pendingSources = new Map<number, Deferred<TestVoiceAudioContext['sources'][number]>>();
    readonly processorCreated = this.processorCreatedEvent.promise;
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
        stopped: Promise<void>;
        started: Promise<void>;
    }> = [];
    readonly createMediaStreamSource = vi.fn((_stream: MediaStream) => this.captureSource);
    readonly createScriptProcessor = vi.fn(() => {
        this.processorCreatedEvent.resolve();
        return this.processor;
    });
    readonly createGain = vi.fn(() => ({ gain: this.gain, connect: vi.fn(), disconnect: this.disconnectGain }));
    readonly createBuffer = vi.fn((_channels: number, length: number) => {
        const samples = new Float32Array(length);
        return { samples, getChannelData: () => samples };
    });
    readonly createBufferSource = vi.fn(() => {
        const stopped = createDeferred<void>();
        const started = createDeferred<void>();
        const source = { buffer: null, onended: null, start: vi.fn(() => started.resolve()), stop: vi.fn(() => stopped.resolve()), disconnect: vi.fn(), connect: vi.fn(), stopped: stopped.promise, started: started.promise };
        this.sources.push(source);
        this.pendingSources.get(this.sources.length - 1)?.resolve(source);
        return source;
    });
    sourceCreated(index = 0): Promise<TestVoiceAudioContext['sources'][number]> {
        const existing = this.sources[index];
        if (existing) return Promise.resolve(existing);
        let pending = this.pendingSources.get(index);
        if (!pending) {
            pending = createDeferred<TestVoiceAudioContext['sources'][number]>();
            this.pendingSources.set(index, pending);
        }
        return pending.promise;
    }
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
    private lowThreshold = 0;
    private readonly observers = new Set<() => void>();
    readonly subscribe = (notify: () => void): (() => void) => {
        this.observers.add(notify);
        return () => { this.observers.delete(notify); };
    };
    private notify(): void { for (const observer of this.observers) observer(); }
    get bufferedAmountLowThreshold(): number { return this.lowThreshold; }
    set bufferedAmountLowThreshold(value: number) { this.lowThreshold = value; this.notify(); }
    readonly sent: string[] = [];
    private readonly pendingSends: Array<Readonly<{
        matches(value: string): boolean;
        received: Deferred<string>;
    }>> = [];

    send(value: string): void {
        this.sent.push(value);
        this.bufferedAmount += new TextEncoder().encode(value).byteLength;
        this.notify();
        for (let index = this.pendingSends.length - 1; index >= 0; index -= 1) {
            const pending = this.pendingSends[index]!;
            if (!pending.matches(value)) continue;
            this.pendingSends.splice(index, 1);
            pending.received.resolve(value);
        }
    }

    /** Actual transport send notification, including an already-recorded matching send. */
    controlSent(matches: (value: string) => boolean): Promise<string> {
        const existing = this.sent.find(matches);
        if (existing !== undefined) return Promise.resolve(existing);
        const received = createDeferred<string>();
        this.pendingSends.push({ matches, received });
        return received.promise;
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
    private readonly dataChannelCreatedEvent = createDeferred<void>();
    private readonly remoteDescriptionSetEvent = createDeferred<void>();
    private readonly closedEvent = createDeferred<void>();
    readonly dataChannelCreated = this.dataChannelCreatedEvent.promise;
    readonly remoteDescriptionSet = this.remoteDescriptionSetEvent.promise;
    readonly closed = this.closedEvent.promise;
    readonly channel = new TestVoiceWebRtcDataChannel();
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    readonly addTrack = vi.fn();
    readonly createDataChannel = vi.fn(() => {
        this.dataChannelCreatedEvent.resolve();
        return this.channel as unknown as RTCDataChannel;
    });
    // Use the Promise API consumed by the host, not the deprecated callback overload.
    readonly createOffer = vi.fn<(options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>>(async () => ({
        type: 'offer' as const,
        sdp: 'v=0\r\na=test-offer\r\n',
    }));
    readonly setLocalDescription = vi.fn<RTCPeerConnection['setLocalDescription']>(async () => {});
    readonly setRemoteDescription = vi.fn<RTCPeerConnection['setRemoteDescription']>(async () => {
        this.remoteDescriptionSetEvent.resolve();
    });
    readonly close = vi.fn(() => {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.channel.close();
        this.closedEvent.resolve();
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
    private readonly stoppedEvent = createDeferred<void>();
    readonly stopped = this.stoppedEvent.promise;
    readonly kind = 'audio';
    enabled = true;
    muted = false;
    private state: MediaStreamTrackState = 'live';
    constructor(readonly id: string) { super(); }
    get readyState(): MediaStreamTrackState { return this.state; }
    // MediaStreamTrack.stop ends the track but does not dispatch `ended`.
    readonly stop = vi.fn(() => { this.state = 'ended'; this.stoppedEvent.resolve(); });
    override dispatchEvent(event: Event): boolean {
        if (event.type === 'ended') this.state = 'ended';
        return super.dispatchEvent(event);
    }
}

type VoiceBrowserCapture = Readonly<{ stream: MediaStream; track: MediaStreamTrack; stopped: Promise<void> }>;

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
    /** Await physical peer construction without sampling the throwing latest-peer getter. */
    peerCreated(index?: number): Promise<TestVoiceWebRtcPeer>;
    micTracks: readonly MediaStreamTrack[];
    micStreams: readonly MediaStream[];
    captures: readonly VoiceBrowserCapture[];
    /** Physical leaf for a getUserMedia fixture that holds its eventual reply. */
    allocateCapture(): VoiceBrowserCapture;
    createMicSession(options?: CreateMicSessionOptions): MicSession;
    restore(): void;
}> {
    const peers: TestVoiceWebRtcPeer[] = [];
    const pendingPeers = new Map<number, Deferred<TestVoiceWebRtcPeer>>();
    const captures: VoiceBrowserCapture[] = [];
    const micTracks: MediaStreamTrack[] = [];
    const micStreams: MediaStream[] = [];
    const allocateCapture = (): VoiceBrowserCapture => {
        // Only the browser SDK shape is supplied here; acquisition, mute and
        // retirement decisions remain in the real WebMicSession owner.
        const physicalTrack = new TestVoiceMicTrack(`test-mic-track-${captures.length + 1}`);
        const track = physicalTrack as unknown as MediaStreamTrack;
        const stream = Object.freeze({
            id: `test-mic-stream-${captures.length + 1}`,
            get active() { return track.readyState === 'live'; },
            getAudioTracks: () => [track],
            getTracks: () => [track],
        }) as unknown as MediaStream;
        const capture = Object.freeze({ stream, track, stopped: physicalTrack.stopped });
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
        pendingPeers.get(peers.length - 1)?.resolve(peer);
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
        peerCreated(index = 0) {
            const existing = peers[index];
            if (existing) return Promise.resolve(existing);
            let pending = pendingPeers.get(index);
            if (!pending) {
                pending = createDeferred<TestVoiceWebRtcPeer>();
                pendingPeers.set(index, pending);
            }
            return pending.promise;
        },
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
