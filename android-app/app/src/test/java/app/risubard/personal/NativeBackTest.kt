package app.risubard.personal

import org.junit.Assert.*
import org.junit.Test

/** JVM-only: the question/answer bookkeeping of the back key (the WebView call itself needs a device). */
class NativeBackTest {
    @Test fun onlyAnExactTrueKeepsTheApp() {
        val back = NativeBack()
        for ((result, leave) in listOf("true" to false, "false" to true, "null" to true, null to true, "\"true\"" to true, "1" to true)) {
            val id = back.ask()!!
            assertEquals("answer $result", leave, back.answered(id, result))
        }
    }
    @Test fun oneQuestionAtATimeAndPressesMeanwhileAreDropped() {
        val back = NativeBack()
        val id = back.ask()!!
        assertNull(back.ask())
        assertEquals(false, back.answered(id, "true"))
        assertNotNull(back.ask())
    }
    @Test fun noAnswerInTimeLeavesAsBeforeAndALateAnswerIsIgnored() {
        val back = NativeBack()
        val id = back.ask()!!
        assertTrue(back.timedOut(id))
        assertNull(back.answered(id, "false")) // late: nothing more happens (the timeout already left)
        assertFalse(back.timedOut(id))
        val next = back.ask()!!
        assertNotEquals(id, next)
        assertEquals(false, back.answered(next, "true"))
        assertFalse(back.timedOut(next)) // answered: the pending timeout does nothing
    }
    @Test fun theScriptOnlyCallsTheHookAndNeverThrows() {
        assertTrue(NativeBack.SCRIPT.contains("window.__risubardAndroidBack"))
        assertTrue(NativeBack.SCRIPT.contains("catch(e){return false}"))
        assertTrue(NativeBack.SCRIPT.contains("f()===true"))
    }
}
