import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isBun } from "./runtime.js";

/*
 * Bun compatibility parser for the Node .env basics covered by this project:
 * whitespace trimming, optional `export`, unquoted comments, single/double
 * quoted values, quoted multiline values, and no process.env override.
 *
 * Intentionally out of scope: variable interpolation, backslash escape
 * handling inside quoted values, YAML-style block scalars, and structured
 * object values. Quoted content is treated literally between quote delimiters.
 */

const runtimeRequire = createRequire(import.meta.url);

export function loadEnvFile(path: string): void {
    if (!isBun) {
        const nodeProcess = runtimeRequire("node:process") as {
            loadEnvFile?: (path?: string) => void;
        };
        if (typeof nodeProcess.loadEnvFile !== "function") {
            throw new Error("process.loadEnvFile is unavailable in this Node runtime");
        }
        nodeProcess.loadEnvFile(path);
        return;
    }

    const parsed = loadEnvFileCompat(path);
    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

export function loadEnvFileCompat(path: string): Record<string, string> {
    return parseEnvContentForCompat(readFileSync(path, "utf-8"));
}

export function parseEnvContentForCompat(raw: string): Record<string, string> {
    const parsed: Record<string, string> = {};
    const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmedStart = line.trimStart();
        if (!trimmedStart || trimmedStart.startsWith("#")) {
            continue;
        }

        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) {
            continue;
        }

        const key = parseKey(line.slice(0, equalsIndex));
        if (!key) {
            continue;
        }

        const parsedValue = parseValue(lines, index, line.slice(equalsIndex + 1));
        parsed[key] = parsedValue.value;
        index = parsedValue.lineIndex;
    }

    return parsed;
}

function parseKey(rawKey: string): string {
    const key = rawKey.trim().replace(/^export\s+/, "").trim();
    return key;
}

function parseValue(
    lines: string[],
    lineIndex: number,
    rawValue: string,
): { value: string; lineIndex: number } {
    const firstValueCharIndex = rawValue.search(/\S/);
    if (firstValueCharIndex === -1) {
        return { value: "", lineIndex };
    }

    const quote = rawValue[firstValueCharIndex];
    if (quote === "'" || quote === '"') {
        return parseQuotedValue(lines, lineIndex, rawValue.slice(firstValueCharIndex + 1), quote);
    }

    const commentIndex = rawValue.indexOf("#");
    const uncommentedValue = commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex);
    return { value: uncommentedValue.trim(), lineIndex };
}

function parseQuotedValue(
    lines: string[],
    lineIndex: number,
    firstLineValue: string,
    quote: string,
): { value: string; lineIndex: number } {
    let value = "";
    let currentLineValue = firstLineValue;
    let currentLineIndex = lineIndex;

    while (currentLineIndex < lines.length) {
        const closingQuoteIndex = currentLineValue.indexOf(quote);
        if (closingQuoteIndex !== -1) {
            value += currentLineValue.slice(0, closingQuoteIndex);
            return { value, lineIndex: currentLineIndex };
        }

        value += currentLineValue;
        currentLineIndex += 1;
        if (currentLineIndex >= lines.length) {
            return { value, lineIndex: currentLineIndex - 1 };
        }
        value += "\n";
        currentLineValue = lines[currentLineIndex];
    }

    return { value, lineIndex: currentLineIndex };
}
