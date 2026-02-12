import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const encryptedEntrySchema = z.object({
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
  updatedAt: z.string()
});

const encryptedVaultSchema = z.record(encryptedEntrySchema);

type VaultData = z.infer<typeof encryptedVaultSchema>;

const ensureDir = async (target: string): Promise<void> => {
  await mkdir(target, { recursive: true });
};

const hashSecret = (secret: string): Buffer => createHash('sha256').update(secret).digest();

export class KeyVault {
  private readonly baseDir: string;
  private readonly vaultFile: string;
  private readonly masterKeyFile: string;
  private secretCache: string | null = null;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.vaultFile = path.join(baseDir, 'provider-keys.enc.json');
    this.masterKeyFile = path.join(baseDir, 'master.key');
  }

  private async loadSecret(): Promise<string> {
    if (this.secretCache) {
      return this.secretCache;
    }

    await ensureDir(this.baseDir);

    if (process.env.VERDANT_MASTER_KEY) {
      this.secretCache = process.env.VERDANT_MASTER_KEY;
      return this.secretCache;
    }

    try {
      const existing = (await readFile(this.masterKeyFile, 'utf8')).trim();
      if (existing) {
        this.secretCache = existing;
        return existing;
      }
    } catch {
      // No existing key file, generate below.
    }

    const generated = randomBytes(32).toString('hex');
    await writeFile(this.masterKeyFile, generated, { encoding: 'utf8', mode: 0o600 });
    this.secretCache = generated;
    return generated;
  }

  private encrypt(secret: string, value: string): { iv: string; tag: string; data: string } {
    const iv = randomBytes(12);
    const key = hashSecret(secret);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  private decrypt(secret: string, payload: { iv: string; tag: string; data: string }): string {
    const key = hashSecret(secret);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  private async loadVault(): Promise<VaultData> {
    try {
      const raw = await readFile(this.vaultFile, 'utf8');
      return encryptedVaultSchema.parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  private async saveVault(vault: VaultData): Promise<void> {
    await ensureDir(this.baseDir);
    await writeFile(this.vaultFile, JSON.stringify(vault, null, 2), 'utf8');
  }

  async setKey(provider: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'groq' | 'openrouter' | 'xai', apiKey: string): Promise<void> {
    const secret = await this.loadSecret();
    const encrypted = this.encrypt(secret, apiKey);
    const vault = await this.loadVault();

    vault[provider] = {
      ...encrypted,
      updatedAt: new Date().toISOString()
    };

    await this.saveVault(vault);
  }

  async getKey(provider: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'groq' | 'openrouter' | 'xai'): Promise<string | null> {
    const secret = await this.loadSecret();
    const vault = await this.loadVault();
    const entry = vault[provider];

    if (!entry) {
      return null;
    }

    try {
      return this.decrypt(secret, entry);
    } catch {
      // If decryption fails (e.g. wrong master key), return null or empty?
      // For now, return null so we don't crash the server.
      return null;
    }
  }

  async deleteKey(provider: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'groq' | 'openrouter' | 'xai'): Promise<void> {
    const vault = await this.loadVault();
    delete vault[provider];
    await this.saveVault(vault);
  }

  async listMasked(): Promise<Record<string, string>> {
    const keys: Record<string, string> = {};

    for (const provider of ['openai', 'anthropic', 'google', 'deepseek', 'groq', 'openrouter', 'xai'] as const) {
      const value = await this.getKey(provider);
      if (!value) {
        continue;
      }

      const visible = value.slice(-4);
      keys[provider] = `••••••••${visible}`;
    }

    return keys;
  }
}
