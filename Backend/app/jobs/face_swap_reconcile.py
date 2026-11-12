"""Bounded CLI supervisor for the existing reconciler. No routes or scheduler."""
import argparse
import asyncio
from collections import Counter
import logging
import re
import subprocess
import sys

logger = logging.getLogger(__name__)
OUTCOMES = frozenset({
    'charged', 'released', 'skipped', 'kept_processing_or_unknown', 'kept_error',
    'review_without_task', 'review_submitting_without_task', 'review_invalid_link_or_evidence',
})


def cursor(value):
    if value is not None and not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('Invalid cursor')
    return value


async def run_scan(reconcile, *, page_size=50, max_pages=10, after_id=None):
    """No financial logic here: bounded pages delegate unchanged to the service."""
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError('Invalid page size')
    if type(max_pages) is not int or not 1 <= max_pages <= 100:
        raise ValueError('Invalid page count')
    after_id = cursor(after_id)
    counts = Counter()
    pages = 0
    for _ in range(max_pages):
        try:
            page = await reconcile(limit=page_size, after_id=after_id)
            results = page['results']
            next_cursor = cursor(page['next_cursor'])
            if not isinstance(results, list) or len(results) > page_size:
                raise ValueError('Invalid page')
            outcomes = [item['outcome'] for item in results]
            if any(not isinstance(value, str) or value not in OUTCOMES for value in outcomes):
                raise ValueError('Invalid outcome')
            if next_cursor is not None and (after_id is not None and next_cursor <= after_id):
                raise ValueError('Non-progressing cursor')
        except Exception:
            logger.error('FaceSwap job outcome=page_error pages=%d resume_after=%s', pages, after_id or 'start')
            return 1
        pages += 1
        counts.update(outcomes)
        logger.info('FaceSwap job page=%d items=%d next_cursor=%s', pages, len(results), next_cursor or 'end')
        after_id = next_cursor
        if after_id is None:
            break
    # Whitelisted outcomes only. Never log operation/user data or exception text.
    for outcome, count in sorted(counts.items()):
        logger.info('FaceSwap job outcome=%s count=%d', outcome, count)
    complete = after_id is None
    logger.info('FaceSwap job complete=%s pages=%d items=%d next_cursor=%s',
                complete, pages, sum(counts.values()), after_id or 'end')
    needs_review = any(counts[value] for value in OUTCOMES if value.startswith('review_') or value == 'kept_error')
    return 0 if complete and not needs_review else 2


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--execute', action='store_true', help='Explicitly enable reads and financial finalization')
    result.add_argument('--page-size', type=int, choices=range(1, 101), default=50, metavar='1..100')
    result.add_argument('--max-pages', type=int, choices=range(1, 101), default=10, metavar='1..100')
    result.add_argument('--max-seconds', type=int, choices=range(1, 901), default=240, metavar='1..900')
    result.add_argument('--after-id', default=None)
    result.add_argument('--_worker', action='store_true', help=argparse.SUPPRESS)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if not args.execute:
        logger.warning('FaceSwap job disabled: explicit --execute required; no services initialized')
        return 2
    try:
        cursor(args.after_id)
    except (ValueError, TypeError):
        logger.error('FaceSwap job invalid cursor')
        return 1
    if args._worker:
        try:
            # Lazy import: --help and disabled invocation cannot initialize Firebase.
            from app.services.face_swap_reconciliation import reconcile_face_swap_reservations
            return asyncio.run(run_scan(reconcile_face_swap_reservations, page_size=args.page_size,
                                        max_pages=args.max_pages, after_id=args.after_id))
        except Exception:
            logger.error('FaceSwap job initialization_or_execution_error')
            return 1
    command = [sys.executable, '-m', 'app.jobs.face_swap_reconcile', '--execute', '--_worker',
               '--page-size', str(args.page_size), '--max-pages', str(args.max_pages)]
    if args.after_id is not None:
        command += ['--after-id', args.after_id]
    try:
        # A process deadline also bounds synchronous Firestore calls that cannot
        # be cancelled reliably by asyncio. Killing never authorizes a release.
        return subprocess.run(command, timeout=args.max_seconds, check=False).returncode
    except subprocess.TimeoutExpired:
        logger.error('FaceSwap job outcome=duration_limit; retain funds and rerun safely')
        return 124
    except Exception:
        logger.error('FaceSwap job outcome=supervisor_error')
        return 1


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    sys.exit(main())
