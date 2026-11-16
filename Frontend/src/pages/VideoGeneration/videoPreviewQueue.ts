type Job = { start: (done: () => void) => void; running: boolean; finished: boolean };
const pending: Job[] = [];
let active = 0;
const LIMIT = 2;
function pump() {
    while (active < LIMIT && pending.length) {
        const job = pending.shift()!;
        if (job.finished) continue;
        job.running = true;
        active++;
        job.start(() => finish(job));
    }
}
function finish(job: Job) {
    if (job.finished) return;
    job.finished = true;
    if (job.running) active--;
    else {
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
    }
    // Let all modal children cancel before starting another queued request.
    queueMicrotask(pump);
}
/** Holds a slot through authorization AND frame loading. Call after aborting on cleanup. */
export function queueVideoPreview(start: Job["start"]): () => void {
    const job: Job = { start, running: false, finished: false };
    pending.push(job);
    pump();
    return () => finish(job);
}
