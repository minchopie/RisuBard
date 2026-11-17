package app.risubard.personal

/** Back key / back gesture: the page is asked first (window.__risubardAndroidBack, installed by
 *  src/ts/transfer-sync/androidBack.ts) and closes its topmost screen. The old default (leave the app) runs
 *  unless the page answers exactly `true`: an older page without the hook, a script error, no answer within
 *  [TIMEOUT_MS] or the start-up screen all keep the old behaviour. One question at a time; a press while one
 *  is open is dropped, and an answer that comes after its timeout is ignored. UI thread only. */
class NativeBack {
    private var asked = 0L
    private var open = 0L

    /** Starts a question and returns its id, or null while another one is still open (the press is dropped). */
    fun ask(): Long? {
        if (open != 0L) return null
        open = ++asked
        return open
    }

    /** The page's answer to question [id]: true = run the old default (leave), false = the page used the key,
     *  null = stale (already timed out), nothing to do. */
    fun answered(id: Long, result: String?): Boolean? {
        if (open != id) return null
        open = 0L
        return result != "true"
    }

    /** Question [id] got no answer in time: true = run the old default now; false = it was already answered. */
    fun timedOut(id: Long): Boolean {
        if (open != id) return false
        open = 0L
        return true
    }

    companion object {
        const val TIMEOUT_MS = 1500L
        const val SCRIPT = "(function(){try{var f=window.__risubardAndroidBack;return typeof f==='function'&&f()===true}catch(e){return false}})()"
    }
}
