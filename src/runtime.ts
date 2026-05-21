type BunGlobal = {
    Bun?: {
        version?: string;
    };
};

export const isBun = (globalThis as BunGlobal).Bun !== undefined;

export function runtimeLabel(): string {
    return isBun ? "bun" : "node";
}

export function runtimeVersion(): string {
    if (isBun) {
        return (globalThis as BunGlobal).Bun?.version || "unknown";
    }
    return process.versions.node;
}
