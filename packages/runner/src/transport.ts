/**
 * Transport: the thin byte/frame layer the JSON-RPC peer rides on. Keeping
 * this interface separate from any concrete socket is what makes the protocol
 * transport-agnostic - a unix socket today, a WebSocket/TLS link for remote
 * attach tomorrow, all without touching `JsonRpcPeer`, `RunnerServer`, or
 * `RemoteSession`.
 *
 * A "frame" is one already-decoded JSON value (an object, in practice). The
 * transport owns framing (how a value becomes bytes and back); peers above it
 * only ever see whole values.
 */
export interface Transport {
  /** Send one frame. Fire-and-forget; ordering is preserved by the transport. */
  send(frame: unknown): void;
  /** Register the (single) handler invoked for each inbound frame. */
  onFrame(handler: (frame: unknown) => void): void;
  /** Register the (single) handler invoked once when the link closes. */
  onClose(handler: (err?: Error) => void): void;
  /** Close the underlying link. */
  close(): void;
}

/**
 * A listener that accepts inbound connections, surfacing each as a
 * {@link Transport}. The runner wraps one of these; clients use the
 * connect-side factory instead.
 */
export interface TransportServer {
  /** Stable address the server is bound to (socket path / pipe name). */
  readonly address: string;
  /** Register the handler invoked for every accepted connection. */
  onConnection(handler: (transport: Transport) => void): void;
  /** Stop listening and release the address. */
  close(): Promise<void>;
}
