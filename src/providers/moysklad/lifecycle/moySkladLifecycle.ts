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
        const accessList = Array.isArray(payload.access) ? payload.access : [];
        const accessItem = accessList[0] as Record<string, unknown> | undefined;
        const accessToken =
          (payload.access_token as string) ||
          (payload.accessToken as string) ||
          (accessItem?.access_token as string) ||
          (accessItem?.accessToken as string) ||
          `tok_${Date.now()}`;
        const fiscalApiId = (fiscalApi.id as string) || (payload.fiscalApiId as string);
        const fiscalApiPublicKey =
          (fiscalApi.token as string) ||
          (fiscalApi.publicKey as string) ||
          (payload.fiscalApiToken as string) ||
          (payload.fiscalApiPublicKey as string);

        const installation: MoySkladAppInstallation = {
          appId,
          accountId,
          accessToken,
          fiscalApiId,
          fiscalApiPublicKey,
          status: 'Activated',
          retailStoreBindings: new Map(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        this.security.registerInstallation(installation);

        return {
          status: 'Activated',
          message: 'SmartDev solution installed and activated.'
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
        let inst = this.security.getInstallation(accountId);

        const additional = (payload.additional as Record<string, unknown>) || {};
        const fiscalApi = (additional.fiscalApi as Record<string, unknown>) || {};
        const accessList = Array.isArray(payload.access) ? payload.access : [];
        const accessItem = accessList[0] as Record<string, unknown> | undefined;
        const accessToken =
          (payload.access_token as string) ||
          (payload.accessToken as string) ||
          (accessItem?.access_token as string) ||
          (accessItem?.accessToken as string);
        const fiscalApiId = (fiscalApi.id as string) || (payload.fiscalApiId as string);
        const fiscalApiPublicKey =
          (fiscalApi.token as string) ||
          (fiscalApi.publicKey as string) ||
          (payload.fiscalApiToken as string) ||
          (payload.fiscalApiPublicKey as string);

        if (!inst) {
          inst = {
            appId,
            accountId,
            accessToken: accessToken || `tok_${Date.now()}`,
            fiscalApiId,
            fiscalApiPublicKey,
            status: 'Activated',
            retailStoreBindings: new Map(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          this.security.registerInstallation(inst);
        } else {
          if (accessToken) inst.accessToken = accessToken;
          if (fiscalApiId) inst.fiscalApiId = fiscalApiId;
          if (fiscalApiPublicKey) inst.fiscalApiPublicKey = fiscalApiPublicKey;
          inst.updatedAt = new Date().toISOString();
        }

        // Save store bindings
        const storeId = payload.storeId as string;
        const agentId = payload.agentId as string;
        const rnm = payload.rnm as string;
        const paperWidthMm = Number(payload.paperWidthMm || 80);

        if (storeId && agentId) {
          inst.retailStoreBindings.set(storeId, { agentId, rnm: rnm || '000123456789', paperWidthMm });
          inst.status = 'Activated';
        }

        return { status: inst.status || 'Activated', message: 'Settings saved.' };
      }

      default:
        return { status: 'Error', error: `Unknown lifecycle action: ${action}` };
    }
  }
}
