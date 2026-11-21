package com.gimviewer.importer

import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Owned by the main thread. The copy worker observes only its own cancellation flag. */
internal class SafImportSlot<Owner : Any, Request> {
    class Attempt<Owner : Any, Request>(val owner: Owner, val request: Request) {
        val cancelled = AtomicBoolean(false)
        internal var copyTask: Future<*>? = null
    }

    // One lane for the current import and one for a cancelled provider call
    // that ignores interrupts. Never queue a new copy behind blocked I/O.
    private val copies = ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS, SynchronousQueue())
    private var current: Attempt<Owner, Request>? = null

    fun begin(owner: Owner, request: Request): Attempt<Owner, Request>? {
        if (current != null) return null
        return Attempt(owner, request).also { current = it }
    }

    fun isCurrent(attempt: Attempt<Owner, Request>): Boolean = current === attempt

    fun startCopy(attempt: Attempt<Owner, Request>, copy: Runnable): Boolean {
        if (!isCurrent(attempt)) return false
        if (attempt.copyTask != null) return true
        return try {
            attempt.copyTask = copies.submit(copy)
            true
        } catch (_: RejectedExecutionException) {
            false
        }
    }

    fun finish(attempt: Attempt<Owner, Request>): Boolean {
        if (!isCurrent(attempt)) return false
        current = null
        return true
    }

    fun cancel(owner: Owner? = null): Attempt<Owner, Request>? {
        val attempt = current ?: return null
        if (owner != null && attempt.owner !== owner) return null
        attempt.cancelled.set(true)
        current = null
        attempt.copyTask?.cancel(true)
        return attempt
    }
}
