package com.gimviewer.importer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SafImportSlotTest {
    private fun waitForProvider(release: CountDownLatch, interrupted: CountDownLatch) {
        // A third-party provider can remain blocked even after cancellation.
        while (true) {
            try {
                release.await()
                return
            } catch (_: InterruptedException) {
                interrupted.countDown()
            }
        }
    }

    @Test
    fun destructionInvalidatesTheOldResultAndAllowsANewActivityToPick() {
        val slot = SafImportSlot<Any, String>()
        val oldActivity = Any()
        val newActivity = Any()
        val old = requireNotNull(slot.begin(oldActivity, "old"))

        assertNull(slot.begin(newActivity, "would overlap"))
        assertSame(old, slot.cancel(oldActivity))
        assertTrue(old.cancelled.get())

        val fresh = requireNotNull(slot.begin(newActivity, "fresh"))
        assertNull(slot.cancel(oldActivity))
        assertFalse(slot.finish(old))
        assertTrue(slot.isCurrent(fresh))
        assertFalse(fresh.cancelled.get())
        assertTrue(slot.finish(fresh))
    }

    @Test
    fun cancellingASelectionOrCopyOnlyCancelsItsOwnAttempt() {
        val slot = SafImportSlot<Any, String>()
        val activity = Any()
        val cancelled = requireNotNull(slot.begin(activity, "cancelled"))
        assertSame(cancelled, slot.cancel())
        assertNull(slot.cancel())
        val retry = requireNotNull(slot.begin(activity, "retry"))
        assertTrue(cancelled.cancelled.get())
        assertFalse(retry.cancelled.get())
        assertFalse(slot.finish(cancelled))
        assertTrue(slot.finish(retry))
    }

    @Test
    fun retryCopiesWhileTheCancelledProviderStillHasNotReturned() {
        val slot = SafImportSlot<Any, String>()
        val activity = Any()
        val old = requireNotNull(slot.begin(activity, "remote"))
        val oldStarted = CountDownLatch(1)
        val oldInterrupted = CountDownLatch(1)
        val releaseOld = CountDownLatch(1)
        val oldReturned = CountDownLatch(1)
        val retryCopied = CountDownLatch(1)
        try {
            assertTrue(slot.startCopy(old) {
                oldStarted.countDown()
                waitForProvider(releaseOld, oldInterrupted)
                oldReturned.countDown()
            })
            assertTrue(oldStarted.await(5, TimeUnit.SECONDS))
            assertSame(old, slot.cancel())
            assertTrue(oldInterrupted.await(5, TimeUnit.SECONDS))

            val retry = requireNotNull(slot.begin(activity, "local"))
            assertTrue(slot.startCopy(retry) { retryCopied.countDown() })
            assertTrue(retryCopied.await(5, TimeUnit.SECONDS))
            assertEquals(1L, oldReturned.count)
            assertTrue(slot.finish(retry))

            releaseOld.countDown()
            assertTrue(oldReturned.await(5, TimeUnit.SECONDS))
            assertFalse(slot.finish(old))
        } finally {
            releaseOld.countDown()
        }
    }

    @Test
    fun copyCapacityExhaustionRejectsInsteadOfQueuingAnotherAttempt() {
        val slot = SafImportSlot<Any, String>()
        val activity = Any()
        val release = CountDownLatch(1)
        val started = CountDownLatch(2)
        val interrupted = CountDownLatch(2)
        try {
            repeat(2) {
                val attempt = requireNotNull(slot.begin(activity, "blocked $it"))
                val entered = CountDownLatch(1)
                assertTrue(slot.startCopy(attempt) {
                    started.countDown()
                    entered.countDown()
                    waitForProvider(release, interrupted)
                })
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                assertSame(attempt, slot.cancel())
            }
            assertTrue(started.await(5, TimeUnit.SECONDS))
            assertTrue(interrupted.await(5, TimeUnit.SECONDS))
            val retry = requireNotNull(slot.begin(activity, "retry"))
            val unexpectedlyRan = CountDownLatch(1)
            assertFalse(slot.startCopy(retry) { unexpectedlyRan.countDown() })
            assertEquals(1L, unexpectedlyRan.count)
            assertTrue(slot.finish(retry))
        } finally {
            release.countDown()
        }
    }
}
