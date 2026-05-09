import crypto from "node:crypto";

const KEY_PATTERN = /\b(hmp_(?:live|test)_[A-Za-z0-9_-]{12,})\b/g;
const SECRET_FIELD_PATTERN =
    /\b(api[-_ ]?key|app[-_ ]?secret|secret|access[-_ ]?token|token)\b\s*[:=]\s*["']?[^"',\s}]+["']?/gi;

export function sha256Hex(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

export function generateApiKey(prefix = "hmp_live"): string {
    return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

export function constantTimeEqualHex(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function redactSensitive(input: unknown, sensitiveValues: Array<string | undefined | null> = []): string {
    let output = input instanceof Error ? input.message : String(input);

    for (const value of sensitiveValues) {
        if (!value || value.length < 4) continue;
        output = output.split(value).join("[REDACTED]");
    }

    output = output.replace(KEY_PATTERN, "[REDACTED_API_KEY]");
    output = output.replace(SECRET_FIELD_PATTERN, (_match, field: string) => `${field}=[REDACTED]`);

    return output;
}

export function publicKeyPrefix(apiKey: string): string {
    return apiKey.slice(0, 14);
}
