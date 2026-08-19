import crypto from 'crypto';
import {
  LicenseRecord,
  LicenseRegisterRequest,
  LicenseRegisterResponse,
  LicenseVerifyRequest,
  LicenseVerifyResponse,
  LicenseHeartbeatRequest,
  LicenseHeartbeatResponse,
  LicenseRebindRequest,
  LicenseRebindResponse,
  Entitlements
} from '../models/licenseTypes';

export class LicenseServer {
  private licenses: Map<string, LicenseRecord> = new Map(); // licenseKey -> LicenseRecord
  private activationCodeMap: Map<string, string> = new Map(); // activationCode -> licenseKey
  private tokenSecret = 'smartdev_license_secret_key_2026';

  constructor() {
    // Seed default sample license for development / tests
    this.seedDefaultLicense();
  }

  private seedDefaultLicense(): void {
    const defaultLicense: LicenseRecord = {
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      companyName: 'SmartDev Demo Store',
      entitlements: {
        active: true,
        paid: true,
        blocked: false,
        maxAgents: 5,
        maxRnms: 5,
        allowedProviders: ['MOYSKLAD', 'MOCK', '1C'],
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        offlineLimitHours: 24
      },
      seats: [],
      providerBindings: [],
      fpoBindings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.addLicense(defaultLicense);
  }

  public addLicense(license: LicenseRecord): void {
    this.licenses.set(license.licenseKey, { ...license });
    this.activationCodeMap.set(license.activationCode, license.licenseKey);
  }

  public getLicense(licenseKey: string): LicenseRecord | undefined {
    return this.licenses.get(licenseKey);
  }

  public updateLicense(licenseKey: string, updates: Partial<LicenseRecord>): void {
    const existing = this.licenses.get(licenseKey);
    if (!existing) throw new Error(`License ${licenseKey} not found`);
    this.licenses.set(licenseKey, {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }

  public generateDeviceToken(licenseKey: string, agentId: string, hardwareId: string): string {
    return crypto
      .createHmac('sha256', this.tokenSecret)
      .update(`${licenseKey}:${agentId}:${hardwareId}:${Date.now()}`)
      .digest('hex');
  }

  /**
   * UC-19: License activation
   */
  public async register(req: LicenseRegisterRequest): Promise<LicenseRegisterResponse> {
    const licenseKey = this.activationCodeMap.get(req.activationCode);
    if (!licenseKey) {
      throw new Error(`Invalid activation code: ${req.activationCode}`);
    }

    const lic = this.licenses.get(licenseKey)!;

    if (!lic.entitlements.active) {
      throw new Error('License is not active');
    }
    if (!lic.entitlements.paid) {
      throw new Error('License is unpaid');
    }
    if (lic.entitlements.blocked) {
      throw new Error('License is blocked');
    }
    if (new Date(lic.entitlements.expiresAt).getTime() < Date.now()) {
      throw new Error('License has expired');
    }

    // Check allowed providers
    if (req.providerCode && !lic.entitlements.allowedProviders.map(p => p.toUpperCase()).includes(req.providerCode.toUpperCase())) {
      throw new Error(`Provider '${req.providerCode}' is not permitted by license entitlements.`);
    }

    // Find existing seat or create new
    let seat = lic.seats.find((s) => s.agentId === req.agentId);
    if (seat) {
      // If seat exists, check hardwareId
      if (seat.hardwareId !== req.hardwareId) {
        throw new Error(`HARDWARE_MISMATCH: Agent ID ${req.agentId} is bound to a different hardware profile.`);
      }
      seat.lastHeartbeatAt = new Date().toISOString();
    } else {
      // Check seat limit
      if (lic.seats.length >= lic.entitlements.maxAgents) {
        throw new Error(`License agent seat limit reached (${lic.entitlements.maxAgents}).`);
      }
      seat = {
        seatId: `seat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        agentId: req.agentId,
        hardwareId: req.hardwareId,
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString()
      };
      lic.seats.push(seat);
    }

    // Provider binding
    if (req.providerCode && req.providerAccountId) {
      const existingBinding = lic.providerBindings.find(
        (b) => b.providerCode === req.providerCode && b.providerAccountId === req.providerAccountId
      );
      if (!existingBinding) {
        lic.providerBindings.push({
          bindingId: `bind-${Date.now()}`,
          providerCode: req.providerCode,
          providerAccountId: req.providerAccountId,
          agentId: req.agentId,
          createdAt: new Date().toISOString()
        });
      }
    }

    // FPO RNM binding
    if (req.rnm) {
      const existingRnm = lic.fpoBindings.find((f) => f.rnm === req.rnm);
      if (!existingRnm) {
        if (lic.fpoBindings.length >= lic.entitlements.maxRnms) {
          throw new Error(`License RNM limit reached (${lic.entitlements.maxRnms}).`);
        }
        lic.fpoBindings.push({
          rnm: req.rnm,
          agentId: req.agentId,
          createdAt: new Date().toISOString()
        });
      }
    }

    lic.updatedAt = new Date().toISOString();
    const deviceToken = this.generateDeviceToken(lic.licenseKey, req.agentId, req.hardwareId);

    return {
      success: true,
      licenseKey: lic.licenseKey,
      deviceToken,
      entitlements: lic.entitlements
    };
  }

  /**
   * Pre-flight verification before fiscal operation
   */
  public async verify(req: LicenseVerifyRequest): Promise<LicenseVerifyResponse> {
    const lic = this.licenses.get(req.licenseKey);
    if (!lic) {
      return { valid: false, errorCode: 'LICENSE_NOT_FOUND', reason: 'License key not found' };
    }

    if (!lic.entitlements.active) {
      return { valid: false, errorCode: 'LICENSE_INACTIVE', reason: 'License is inactive' };
    }
    if (!lic.entitlements.paid) {
      return { valid: false, errorCode: 'LICENSE_UNPAID', reason: 'License payment is overdue' };
    }
    if (lic.entitlements.blocked) {
      return { valid: false, errorCode: 'LICENSE_BLOCKED', reason: 'License is blocked by administrator' };
    }
    if (new Date(lic.entitlements.expiresAt).getTime() < Date.now()) {
      return { valid: false, errorCode: 'LICENSE_EXPIRED', reason: 'License subscription has expired' };
    }

    const seat = lic.seats.find((s) => s.agentId === req.agentId);
    if (!seat) {
      return { valid: false, errorCode: 'SEAT_NOT_FOUND', reason: 'Agent seat not registered for this license' };
    }

    // HWID check (UC-22)
    if (seat.hardwareId !== req.hardwareId) {
      return { valid: false, errorCode: 'HARDWARE_MISMATCH', reason: 'Hardware fingerprint mismatch detected' };
    }

    // Provider check (UC-23)
    if (req.providerCode && !lic.entitlements.allowedProviders.map(p => p.toUpperCase()).includes(req.providerCode.toUpperCase())) {
      return { valid: false, errorCode: 'PROVIDER_NOT_ALLOWED', reason: `Provider ${req.providerCode} not allowed` };
    }

    return {
      valid: true,
      entitlements: lic.entitlements
    };
  }

  /**
   * Heartbeat
   */
  public async heartbeat(req: LicenseHeartbeatRequest): Promise<LicenseHeartbeatResponse> {
    const lic = this.licenses.get(req.licenseKey);
    if (!lic) {
      return { status: 'INVALID_TOKEN', message: 'License not found' };
    }

    if (lic.entitlements.blocked) {
      return { status: 'BLOCKED', entitlements: lic.entitlements, message: 'License blocked' };
    }
    if (!lic.entitlements.paid) {
      return { status: 'UNPAID', entitlements: lic.entitlements, message: 'License unpaid' };
    }
    if (new Date(lic.entitlements.expiresAt).getTime() < Date.now()) {
      return { status: 'EXPIRED', entitlements: lic.entitlements, message: 'License expired' };
    }

    const seat = lic.seats.find((s) => s.agentId === req.agentId);
    if (!seat || seat.hardwareId !== req.hardwareId) {
      return { status: 'HARDWARE_MISMATCH', message: 'Hardware fingerprint mismatch' };
    }

    seat.lastHeartbeatAt = new Date().toISOString();
    return {
      status: 'OK',
      entitlements: lic.entitlements
    };
  }

  /**
   * Rebind hardware (UC-22)
   */
  public async rebind(req: LicenseRebindRequest): Promise<LicenseRebindResponse> {
    if (req.authSecret !== 'SMARTDEV_SUPER_ADMIN_AUTH') {
      throw new Error('Unauthorized rebind attempt. Admin auth secret required.');
    }

    const lic = this.licenses.get(req.licenseKey);
    if (!lic) {
      throw new Error('License not found');
    }

    let seat = lic.seats.find((s) => s.agentId === req.agentId);
    if (!seat) {
      throw new Error(`Agent seat ${req.agentId} not found on license.`);
    }

    seat.hardwareId = req.newHardwareId;
    seat.lastHeartbeatAt = new Date().toISOString();
    lic.updatedAt = new Date().toISOString();

    const newDeviceToken = this.generateDeviceToken(lic.licenseKey, req.agentId, req.newHardwareId);
    return {
      success: true,
      newDeviceToken,
      message: 'Agent hardware rebind successful'
    };
  }
}
