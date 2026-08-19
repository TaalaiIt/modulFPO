import { MoySkladSecurity, MoySkladAppInstallation } from '../security/moySkladSecurity';
import { VendorLifecycleEvent, VendorLifecycleResult } from '../../common/IProviderAdapter';
import { AuditLogger, AuditEventType } from '../../../core/audit/auditLogger';

export class MoySkladLifecycle {
  private security: MoySkladSecurity;
  private auditLogger?: AuditLogger;

  constructor(security: MoySkladSecurity, auditLogger?: AuditLogger) {
    this.security = security;
    this.auditLogger = auditLogger;
  }

  public async handleEvent(event: VendorLifecycleEvent): Promise<VendorLifecycleResult> {
    const { action, appId, accountId, payload } = event;

    this.auditLogger?.log({
      eventType: AuditEventType.PROVIDER_LIFECYCLE,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      message: `MoySklad Vendor API lifecycle event received: ${action} for appId ${appId}`
    });

    switch (action) {
      case 'INSTALL': {
        const additional = (payload.additional as Record<string, unknown>) || {};
        const fiscalApi = (additional.fiscalApi as Record<string, unknown>) || {};
        const accessToken = (payload.access_token as string) || (payload.accessToken as string) || `tok_${Date.now()}`;
        const fiscalApiId = fiscalApi.id as string;
        const fiscalApiPublicKey = (fiscalApi.token as string) || (fiscalApi.publicKey as string);

        const installation: MoySkladAppInstallation = {
          appId,
          accountId,
          accessToken,
          fiscalApiId,
          fiscalApiPublicKey,
          status: 'SettingsRequired', // UC-01: initially SettingsRequired until store/agent paired
          retailStoreBindings: new Map(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        this.security.registerInstallation(installation);

        return {
          status: 'SettingsRequired',
          message: 'SmartDev solution installed. Configuration of retail store and local agent is required.'
        };
      }

      case 'ACTIVATE':
      case 'RESUME': {
        const inst = this.security.getInstallation(accountId);
        if (!inst) {
          return { status: 'Error', error: `Installation for account ${accountId} not found.` };
        }
        inst.status = 'Activated';
        inst.updatedAt = new Date().toISOString();
        return { status: 'Activated', message: 'SmartDev solution activated.' };
      }

      case 'SUSPEND': {
        const inst = this.security.getInstallation(accountId);
        if (!inst) {
          return { status: 'Error', error: `Installation for account ${accountId} not found.` };
        }
        inst.status = 'Suspended';
        inst.updatedAt = new Date().toISOString();
        return { status: 'Suspended', message: 'SmartDev solution suspended.' };
      }

      case 'DELETE': {
        this.security.removeInstallation(accountId);
        return { status: 'Deleted', message: 'SmartDev solution uninstalled and token revoked.' };
      }

      case 'SETTINGS_UPDATE': {
        const inst = this.security.getInstallation(accountId);
        if (!inst) {
          return { status: 'Error', error: `Installation for account ${accountId} not found.` };
        }
        // Save store bindings
        const storeId = payload.storeId as string;
        const agentId = payload.agentId as string;
        const rnm = payload.rnm as string;
        const paperWidthMm = Number(payload.paperWidthMm || 80);

        if (storeId && agentId) {
          inst.retailStoreBindings.set(storeId, { agentId, rnm: rnm || '000123456789', paperWidthMm });
          inst.status = 'Activated'; // Move to Activated once store is paired (UC-01)
        }

        return { status: inst.status, message: 'Settings saved.' };
      }

      default:
        return { status: 'Error', error: `Unknown lifecycle action: ${action}` };
    }
  }
}
