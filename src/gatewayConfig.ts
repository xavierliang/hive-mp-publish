import fs from "node:fs/promises";
import path from "node:path";
import { configDir } from "@wenyan-md/core/wrapper";

export const DEFAULT_GATEWAY_SERVER = "https://mp.resopod.cn";

export interface StoredGatewayCredential {
    server?: string;
    apiKey?: string;
}

interface CredentialFile {
    wechat?: Record<string, { appSecret: string; alias?: string }>;
    gateway?: StoredGatewayCredential;
}

export function getCredentialPath(): string {
    return process.env.HIVE_MP_CREDENTIAL_PATH || path.join(configDir, "credential.json");
}

export async function loadGatewayCredential(): Promise<StoredGatewayCredential | null> {
    const credential = await loadCredentialFile();
    return credential.gateway || null;
}

export async function saveGatewayCredential(gateway: Required<StoredGatewayCredential>): Promise<void> {
    const credential = await loadCredentialFile();
    credential.gateway = {
        server: gateway.server.trim(),
        apiKey: gateway.apiKey.trim(),
    };
    await saveCredentialFile(credential);
}

export async function clearGatewayCredential(): Promise<boolean> {
    const credential = await loadCredentialFile();
    if (!credential.gateway) return false;
    delete credential.gateway;
    await saveCredentialFile(credential);
    return true;
}

export function redactApiKey(apiKey: string | undefined): string {
    if (!apiKey) return "(not set)";
    if (apiKey.length <= 12) return "[REDACTED]";
    return `${apiKey.slice(0, 14)}...${apiKey.slice(-4)}`;
}

async function loadCredentialFile(): Promise<CredentialFile> {
    const credentialPath = getCredentialPath();
    try {
        const raw = await fs.readFile(credentialPath, "utf-8");
        return JSON.parse(raw) as CredentialFile;
    } catch (error: any) {
        if (error?.code === "ENOENT") return {};
        throw new Error(`无法加载凭据: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}

async function saveCredentialFile(credential: CredentialFile): Promise<void> {
    const credentialPath = getCredentialPath();
    await fs.mkdir(path.dirname(credentialPath), { recursive: true });
    await fs.writeFile(credentialPath, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(credentialPath, 0o600);
}
