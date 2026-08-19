import WebSocket from 'ws';
import { AgentService } from '../agentService';
import { NormalizedFiscalOperation, FiscalResult } from '../../core/operations/types';
import { AuditLogger, AuditEventType } from '../../core/audit/auditLogger';

export interface AgentWsConfig {
  gatewayUrl: string; // e.g. ws://localhost:3000/agent-ws
  agentId: string;
  deviceToken: string;
  reconnectIntervalMs?: number;
}

export class AgentWsClient {
  private config: Required<AgentWsConfig>;
  private agentService: AgentService;
  private ws: WebSocket | null = null;
  private isRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private auditLogger?: AuditLogger;

  constructor(config: AgentWsConfig, agentService: AgentService, auditLogger?: AuditLogger) {
    this.config = {
      gatewayUrl: config.gatewayUrl,
      agentId: config.agentId,
      deviceToken: config.deviceToken,
      reconnectIntervalMs: config.reconnectIntervalMs || 3000
    };
    this.agentService = agentService;
    this.auditLogger = auditLogger;
  }

  public start(): void {
    this.isRunning = true;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (!this.isRunning) return;

    const url = `${this.config.gatewayUrl}?agentId=${encodeURIComponent(this.config.agentId)}&token=${encodeURIComponent(this.config.deviceToken)}`;
    
    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.auditLogger?.log({
          eventType: AuditEventType.DIAGNOSTIC_RUN,
          agentId: this.config.agentId,
          message: `Fiscal Agent connected to Gateway at ${this.config.gatewayUrl}`
        });

        // Send hello & diagnostics
        this.sendHello();
      });

      this.ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'COMMAND') {
            await this.handleCommand(msg.id, msg.operation as NormalizedFiscalOperation);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.auditLogger?.log({
            eventType: AuditEventType.OPERATION_FAILED,
            agentId: this.config.agentId,
            message: `Error processing incoming gateway message: ${msg}`
          });
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', () => {
        if (this.ws) {
          this.ws.close();
        }
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private async sendHello(): Promise<void> {
    if (!this.isConnected()) return;
    const diag = await this.agentService.runDiagnostics();
    this.ws?.send(
      JSON.stringify({
        type: 'AGENT_HELLO',
        agentId: this.config.agentId,
        diagnostics: diag,
        timestamp: new Date().toISOString()
      })
    );
  }

  private async handleCommand(commandId: string, operation: NormalizedFiscalOperation): Promise<void> {
    const result: FiscalResult = await this.agentService.executeOperation(operation);
    
    if (this.isConnected()) {
      this.ws?.send(
        JSON.stringify({
          type: 'COMMAND_RESULT',
          id: commandId,
          result
        })
      );
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectIntervalMs);
  }
}
