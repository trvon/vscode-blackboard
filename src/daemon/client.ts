/**
 * High-level YAMS daemon IPC client.
 *
 * Wraps SocketConnection + FrameReader to provide typed request/response
 * methods using protobuf Envelope messages over the binary frame protocol.
 *
 * Each public method:
 *   1. Creates a protobuf request message
 *   2. Wraps it in an Envelope with a unique requestId
 *   3. Serializes to binary via toBinary()
 *   4. Sends as a framed message
 *   5. Waits for the matching response frame(s)
 *   6. Decodes the Envelope and extracts the typed response
 */

import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
    type Envelope,
    EnvelopeSchema,
    // Request schemas
    PingRequestSchema,
    StatusRequestSchema,
    SearchRequestSchema,
    AddDocumentRequestSchema,
    CatRequestSchema,
    ListRequestSchema,
    GrepRequestSchema,
    UpdateDocumentRequestSchema,
    GraphQueryRequestSchema,
    UseSessionRequestSchema,
    KvPairSchema,
    // Response types
    type PongResponse,
    type StatusResponse,
    type SearchResponse,
    type AddDocumentResponse,
    type CatResponse,
    type ListResponse,
    type GrepResponse,
    type UpdateDocumentResponse,
    type GraphQueryResponse,
    type SuccessResponse,
    type ErrorResponse,
    // Response type helpers
    type SearchResult,
    type ListEntry,
    type GrepMatch,
    type KvPair,
} from "./proto/ipc_envelope_pb.js";
import {
    FrameReader,
    encodeFrame,
    isChunked,
    isLastChunk,
    isError,
    type Frame,
} from "./framing.js";
import { SocketConnection, type SocketConnectionOptions } from "./socket.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class DaemonError extends Error {
    constructor(
        public readonly code: number,
        message: string,
    ) {
        super(message);
        this.name = "DaemonError";
    }
}

export class RequestTimeoutError extends Error {
    constructor(
        public readonly requestId: bigint,
        timeoutMs: number,
    ) {
        super(`Request ${requestId} timed out after ${timeoutMs}ms`);
        this.name = "RequestTimeoutError";
    }
}

// -----------------------------------------------------------------------------
// Pending request tracking
// -----------------------------------------------------------------------------

interface PendingRequest {
    resolve: (envelope: Envelope) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Accumulated chunks for chunked responses. */
    chunks: Uint8Array[];
}

// -----------------------------------------------------------------------------
// Client options
// -----------------------------------------------------------------------------

export interface YamsDaemonClientOptions extends SocketConnectionOptions {
    /** Default timeout for requests in ms (default: 30_000). */
    requestTimeoutMs?: number;
    /** Client version string sent in Envelope (default: "vscode-blackboard/0.1.0"). */
    clientVersion?: string;
}

// -----------------------------------------------------------------------------
// YamsDaemonClient
// -----------------------------------------------------------------------------

export class YamsDaemonClient {
    private readonly conn: SocketConnection;
    private readonly reader = new FrameReader();
    private readonly pending = new Map<bigint, PendingRequest>();
    private nextRequestId = 1n;
    private readonly requestTimeoutMs: number;
    private readonly clientVersion: string;

    constructor(opts: YamsDaemonClientOptions = {}) {
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
        this.clientVersion = opts.clientVersion ?? "vscode-blackboard/0.1.0";
        this.conn = new SocketConnection(opts);
        this.conn.on("data", (chunk) => this.onData(chunk));
        this.conn.on("close", () => this.onClose());
        this.conn.on("error", () => {
            /* errors handled per-request via pending map */
        });
    }

    /** Whether the underlying socket is connected. */
    get connected(): boolean {
        return this.conn.connected;
    }

    /** Connect to the daemon. */
    async connect(): Promise<void> {
        await this.conn.connect();
    }

    /** Disconnect from the daemon. */
    disconnect(): void {
        this.conn.disconnect();
        this.rejectAll(new Error("Client disconnected"));
    }

    /** Permanently dispose the client. */
    dispose(): void {
        this.conn.dispose();
        this.rejectAll(new Error("Client disposed"));
    }

    // -------------------------------------------------------------------------
    // Public API — typed request methods
    // -------------------------------------------------------------------------

    /** Ping the daemon. */
    async ping(): Promise<PongResponse> {
        const req = create(PingRequestSchema, {});
        const resp = await this.send({ case: "pingRequest", value: req });
        return this.extractPayload(resp, "pongResponse");
    }

    /** Get daemon status. */
    async status(): Promise<StatusResponse> {
        const req = create(StatusRequestSchema, {});
        const resp = await this.send({ case: "statusRequest", value: req });
        return this.extractPayload(resp, "statusResponse");
    }

    /** Add a document (inline content). */
    async add(opts: {
        content: string;
        name: string;
        tags?: string[];
        metadata?: Array<{ key: string; value: string }>;
        noEmbeddings?: boolean;
    }): Promise<AddDocumentResponse> {
        const kvPairs = (opts.metadata ?? []).map((m) =>
            create(KvPairSchema, { key: m.key, value: m.value }),
        );
        const req = create(AddDocumentRequestSchema, {
            content: opts.content,
            name: opts.name,
            tags: opts.tags ?? [],
            metadata: kvPairs,
            noEmbeddings: opts.noEmbeddings ?? false,
        });
        const resp = await this.send({
            case: "addDocumentRequest",
            value: req,
        });
        return this.extractPayload(resp, "addDocumentResponse");
    }

    /** Retrieve document content by name or hash (the "cat" operation). */
    async cat(opts: {
        name?: string;
        hash?: string;
    }): Promise<CatResponse> {
        const req = create(CatRequestSchema, {
            name: opts.name ?? "",
            hash: opts.hash ?? "",
        });
        const resp = await this.send({ case: "catRequest", value: req });
        return this.extractPayload(resp, "catResponse");
    }

    /** Search documents. */
    async search(opts: {
        query: string;
        limit?: number;
        fuzzy?: boolean;
        tags?: string[];
        matchAllTags?: boolean;
        similarity?: number;
    }): Promise<SearchResponse> {
        const req = create(SearchRequestSchema, {
            query: opts.query,
            limit: opts.limit ?? 20,
            fuzzy: opts.fuzzy ?? false,
            tags: opts.tags ?? [],
            matchAllTags: opts.matchAllTags ?? false,
            similarity: opts.similarity ?? 0.0,
        });
        const resp = await this.send({ case: "searchRequest", value: req });
        return this.extractPayload(resp, "searchResponse");
    }

    /** List documents. */
    async list(opts?: {
        limit?: number;
        offset?: number;
        tags?: string[];
        matchAllTags?: boolean;
        namePattern?: string;
    }): Promise<ListResponse> {
        const req = create(ListRequestSchema, {
            limit: opts?.limit ?? 100,
            offset: opts?.offset ?? 0,
            tags: opts?.tags ?? [],
            matchAllTags: opts?.matchAllTags ?? false,
            namePattern: opts?.namePattern ?? "",
        });
        const resp = await this.send({ case: "listRequest", value: req });
        return this.extractPayload(resp, "listResponse");
    }

    /** Grep documents by regex pattern. */
    async grep(opts: {
        pattern: string;
        filterTags?: string[];
        matchAllTags?: boolean;
    }): Promise<GrepResponse> {
        const req = create(GrepRequestSchema, {
            pattern: opts.pattern,
            filterTags: opts.filterTags ?? [],
            matchAllTags: opts.matchAllTags ?? false,
        });
        const resp = await this.send({ case: "grepRequest", value: req });
        return this.extractPayload(resp, "grepResponse");
    }

    /** Update a document's tags/metadata. */
    async update(opts: {
        name?: string;
        hash?: string;
        addTags?: string[];
        removeTags?: string[];
        metadata?: Array<{ key: string; value: string }>;
    }): Promise<UpdateDocumentResponse> {
        const kvPairs = (opts.metadata ?? []).map((m) =>
            create(KvPairSchema, { key: m.key, value: m.value }),
        );
        const req = create(UpdateDocumentRequestSchema, {
            name: opts.name ?? "",
            hash: opts.hash ?? "",
            addTags: opts.addTags ?? [],
            removeTags: opts.removeTags ?? [],
            metadata: kvPairs,
        });
        const resp = await this.send({
            case: "updateDocumentRequest",
            value: req,
        });
        return this.extractPayload(resp, "updateDocumentResponse");
    }

    /** Query the knowledge graph. */
    async graphQuery(opts: {
        documentName?: string;
        documentHash?: string;
        maxDepth?: number;
        maxResults?: number;
    }): Promise<GraphQueryResponse> {
        const req = create(GraphQueryRequestSchema, {
            documentName: opts.documentName ?? "",
            documentHash: opts.documentHash ?? "",
            maxDepth: opts.maxDepth ?? 2,
            maxResults: opts.maxResults ?? 100,
        });
        const resp = await this.send({
            case: "graphQueryRequest",
            value: req,
        });
        return this.extractPayload(resp, "graphQueryResponse");
    }

    /** Switch the active session. */
    async useSession(sessionName: string): Promise<SuccessResponse> {
        const req = create(UseSessionRequestSchema, { sessionName });
        const resp = await this.send({
            case: "useSessionRequest",
            value: req,
        });
        return this.extractPayload(resp, "successResponse");
    }

    // -------------------------------------------------------------------------
    // Send / receive internals
    // -------------------------------------------------------------------------

    /**
     * Send a request and wait for the correlated response.
     * Handles chunked responses transparently.
     */
    private send(
        payload: Envelope["payload"],
        timeoutMs?: number,
    ): Promise<Envelope> {
        const requestId = this.nextRequestId++;
        const envelope = create(EnvelopeSchema, {
            version: 1,
            requestId,
            clientVersion: this.clientVersion,
            payload,
        });

        const bytes = toBinary(EnvelopeSchema, envelope);
        const frame = encodeFrame(bytes);

        return new Promise<Envelope>((resolve, reject) => {
            const timeout = timeoutMs ?? this.requestTimeoutMs;
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new RequestTimeoutError(requestId, timeout));
            }, timeout);

            this.pending.set(requestId, {
                resolve,
                reject,
                timer,
                chunks: [],
            });

            try {
                this.conn.write(frame);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(err);
            }
        });
    }

    /** Process incoming socket data through the frame reader. */
    private onData(chunk: Buffer): void {
        this.reader.append(chunk);
        let frame: Frame | null;
        while ((frame = this.reader.tryReadFrame())) {
            this.handleFrame(frame);
        }
    }

    /** Handle a single complete frame. */
    private handleFrame(frame: Frame): void {
        let envelope: Envelope;
        try {
            envelope = fromBinary(EnvelopeSchema, frame.payload);
        } catch (err) {
            // Can't decode — drop the frame
            console.error("[yams-client] Failed to decode envelope:", err);
            return;
        }

        const requestId = envelope.requestId;
        const pending = this.pending.get(requestId);
        if (!pending) {
            // No matching request — could be a notification or stale response
            return;
        }

        // Check if this is an error response
        if (
            isError(frame.header.flags) ||
            envelope.payload.case === "error"
        ) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            const errPayload = envelope.payload.value as ErrorResponse;
            pending.reject(
                new DaemonError(
                    errPayload?.code ?? -1,
                    errPayload?.message ?? "Unknown daemon error",
                ),
            );
            return;
        }

        // Handle chunked responses
        if (isChunked(frame.header.flags)) {
            pending.chunks.push(frame.payload);
            if (isLastChunk(frame.header.flags)) {
                // Reassemble: the last chunk's envelope is the final response
                // (each chunk is a complete envelope — the daemon sends the
                // full response in the last chunk for our use case)
                clearTimeout(pending.timer);
                this.pending.delete(requestId);
                pending.resolve(envelope);
            }
            // Otherwise, wait for more chunks
            return;
        }

        // Non-chunked: resolve immediately
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve(envelope);
    }

    /** Extract a typed payload from a response envelope. */
    private extractPayload<
        C extends Exclude<Envelope["payload"]["case"], undefined>,
    >(
        envelope: Envelope,
        expectedCase: C,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any {
        if (envelope.payload.case === "error") {
            const err = envelope.payload.value as ErrorResponse;
            throw new DaemonError(err.code, err.message);
        }
        if (envelope.payload.case !== expectedCase) {
            throw new DaemonError(
                -1,
                `Unexpected response type: expected "${expectedCase}", got "${envelope.payload.case ?? "undefined"}"`,
            );
        }
        return envelope.payload.value;
    }

    /** Reject all pending requests (called on close/dispose). */
    private rejectAll(error: Error): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    /** Handle socket close: reject all pending requests. */
    private onClose(): void {
        this.rejectAll(new Error("Connection closed"));
    }
}

// Re-export types that consumers will need
export type {
    Envelope,
    PongResponse,
    StatusResponse,
    SearchResponse,
    AddDocumentResponse,
    CatResponse,
    ListResponse,
    ListEntry,
    GrepResponse,
    GrepMatch,
    UpdateDocumentResponse,
    GraphQueryResponse,
    SuccessResponse,
    ErrorResponse,
    SearchResult,
    KvPair,
};
