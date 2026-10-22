type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface GateOptions {
    fetchImpl?: FetchLike
    now?: () => number
    wait?: (milliseconds: number) => Promise<void>
    minIntervalMs?: number
    rateLimitBackoffMs?: number
    networkBackoffMs?: number
    serverBackoffMs?: number
}

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
})

/**
 * Serializes the keyless Google Translate fallback used by RisuAI. Opening a
 * large imported chat can otherwise mount many ChatBody components at once,
 * creating a request burst that the endpoint answers with 429. A 429 response
 * has no CORS header and reaches WebView JavaScript only as `Failed to fetch`.
 */
export class PrivateMobileGoogleTranslateGate {
    private queue: Promise<void> = Promise.resolve()
    private nextStartAt = 0
    private blockedUntil = 0
    private readonly fetchImpl: FetchLike
    private readonly now: () => number
    private readonly wait: (milliseconds: number) => Promise<void>
    private readonly minIntervalMs: number
    private readonly rateLimitBackoffMs: number
    private readonly networkBackoffMs: number
    private readonly serverBackoffMs: number

    constructor(options: GateOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
        this.now = options.now ?? Date.now
        this.wait = options.wait ?? defaultWait
        this.minIntervalMs = options.minIntervalMs ?? 250
        this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 60_000
        this.networkBackoffMs = options.networkBackoffMs ?? 30_000
        this.serverBackoffMs = options.serverBackoffMs ?? 10_000
    }

    request(url: string): Promise<Response | null> {
        const request = this.queue.then(async () => {
            let currentTime = this.now()
            if (currentTime < this.blockedUntil) {
                return null
            }

            const delay = Math.max(0, this.nextStartAt - currentTime)
            if (delay > 0) {
                await this.wait(delay)
                currentTime = this.now()
            }
            if (currentTime < this.blockedUntil) {
                return null
            }
            this.nextStartAt = currentTime + this.minIntervalMs

            try {
                const result = await this.fetchImpl(url, { method: 'GET' })
                if (result.status === 429 || result.status === 403) {
                    this.blockedUntil = this.now() + this.rateLimitBackoffMs
                } else if (result.status >= 500) {
                    this.blockedUntil = this.now() + this.serverBackoffMs
                }
                return result
            } catch {
                // Chromium hides a CORS-less 429 as a TypeError. Treat every
                // transport rejection as a short circuit so queued history
                // messages fall back immediately instead of retrying in bulk.
                this.blockedUntil = this.now() + this.networkBackoffMs
                return null
            }
        })

        this.queue = request.then(() => undefined, () => undefined)
        return request
    }
}

export function shouldBatchPrivateMobileGoogleTranslation(
    privateMobileLocalMode: boolean,
    translatorType: string,
): boolean {
    return privateMobileLocalMode && translatorType === 'google'
}
