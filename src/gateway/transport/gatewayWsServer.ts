import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { IAgentTransport } from '../../core/routing/routingService';
import { AuditLogger, AuditEventType } from '../../core/audit/auditLogger';

export interface PendingCommand {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeoutTimer: NodeJS.Timeout;
}

export class WsAgentTransport implements IAgentTransport {
  public readonly agentId: string;
  private ws: WebSocket;
  private pendingCommands: Map<string, PendingCommand> = new Map();
  private auditLogger?: AuditLogger;

  constructor(agentId: string, ws: WebSocket, auditLogger?: AuditLogger) {
    this.agentId = agentId;
    this.ws = ws;
    this.auditLogger = auditLogger;

    this.ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'COMMAND_RESULT') {
          const pending = this.pendingCommands.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeoutTimer);
            this.pendingCommands.delete(msg.id);
            pending.resolve(msg.result);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.auditLogger?.log({
          eventType: AuditEventType.OPERATION_FAILED,
          agentId: this.agentId,
          message: `Failed to parse message from agent ${this.agentId}: ${message}`
        });
      }
    });
  }

  public isOnline(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  public async send<TReq, TRes>(type: string, payload: TReq, timeoutMs = 15000): Promise<TRes> {
    if (!this.isOnline()) {
      throw new Error(`Agent ${this.agentId} WebSocket is not open (state: ${this.ws.readyState}).`);
    }

    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    return new Promise<TRes>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for agent ${this.agentId} command response.`));
      }, timeoutMs);

      this.pendingCommands.set(commandId, { resolve, reject, timeoutTimer });

      this.ws.send(
        JSON.stringify({
          type,
          id: commandId,
          operation: payload
        })
      );
    });
  }
}

export class GatewayWsServer {
  private wss: WebSocketServer | null = null;
  private onAgentConnected?: (agentId: string, transport: WsAgentTransport) => void;
  private onAgentDisconnected?: (agentId: string) => void;
  private validateAgentToken?: (agentId: string, token: string) => boolean;
  private auditLogger?: AuditLogger;

  constructor(options?: {
    onAgentConnected?: (agentId: string, transport: WsAgentTransport) => void;
    onAgentDisconnected?: (agentId: string) => void;
    validateAgentToken?: (agentId: string, token: string) => boolean;
    auditLogger?: AuditLogger;
  }) {
    this.onAgentConnected = options?.onAgentConnected;
    this.onAgentDisconnected = options?.onAgentDisconnected;
    this.validateAgentToken = options?.validateAgentToken;
    this.auditLogger = options?.auditLogger;
  }

  public attach(server: any): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: IncomingMessage, socket: any, head: any) => {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/agent-ws') {
        const agentId = url.searchParams.get('agentId');
        const token = url.searchParams.get('token');
        if (!agentId || !token || (this.validateAgentToken && !this.validateAgentToken(agentId, token))) {
          socket.destroy();
          return;
        }

        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const agentId = url.searchParams.get('agentId') || 'unknown-agent';

      const transport = new WsAgentTransport(agentId, ws, this.auditLogger);

      this.auditLogger?.log({
        eventType: AuditEventType.DIAGNOSTIC_RUN,
        agentId,
        message: `Agent ${agentId} connected to Gateway WebSocket.`
      });

      this.onAgentConnected?.(agentId, transport);

      ws.on('close', () => {
        this.auditLogger?.log({
          eventType: AuditEventType.DIAGNOSTIC_RUN,
          agentId,
          message: `Agent ${agentId} disconnected from Gateway WebSocket.`
        });
        this.onAgentDisconnected?.(agentId);
      });
    });
  }

  public close(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
