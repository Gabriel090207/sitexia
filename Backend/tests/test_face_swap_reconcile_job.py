"""Offline job entry point; no application clients or provider network."""
import asyncio
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location('tested_reconcile_job', Path(__file__).parents[1] / 'app/jobs/face_swap_reconcile.py')
job = importlib.util.module_from_spec(spec); spec.loader.exec_module(job)
A, B = 'a' * 64, 'b' * 64

def page(outcomes=(), next_cursor=None):
    return {'results': [{'generationId': 'PRIVATE_USER_URL', 'outcome': value} for value in outcomes], 'next_cursor': next_cursor}


class ScanTests(unittest.IsolatedAsyncioTestCase):
    async def test_paginated_scan_preserves_cursor_and_bound(self):
        reconcile = AsyncMock(side_effect=[page(['charged', 'released'], A), page(['kept_processing_or_unknown'])])
        self.assertEqual(await job.run_scan(reconcile, page_size=2), 0)
        self.assertEqual(reconcile.await_args_list[0].kwargs, {'limit': 2, 'after_id': None})
        self.assertEqual(reconcile.await_args_list[1].kwargs, {'limit': 2, 'after_id': A})

    async def test_page_limit_is_incomplete_and_resume_is_explicit(self):
        reconcile = AsyncMock(return_value=page(['kept_processing_or_unknown'], B))
        with self.assertLogs(job.logger, level='INFO') as logs:
            self.assertEqual(await job.run_scan(reconcile, page_size=1, max_pages=1, after_id=A), 2)
        reconcile.assert_awaited_once_with(limit=1, after_id=A)
        self.assertIn(B, ' '.join(logs.output))

    async def test_item_errors_and_manual_review_do_not_stop_later_pages(self):
        reconcile = AsyncMock(side_effect=[page(['kept_error', 'review_submitting_without_task'], A), page(['charged'])])
        self.assertEqual(await job.run_scan(reconcile, page_size=2), 2)
        self.assertEqual(reconcile.await_count, 2)

    async def test_failed_page_logs_only_safe_cursor_then_rerun_is_possible(self):
        reconcile = AsyncMock(side_effect=[page(['charged'], A), RuntimeError('SECRET_URL_PROMPT')])
        with self.assertLogs(job.logger, level='INFO') as logs:
            self.assertEqual(await job.run_scan(reconcile, page_size=1), 1)
        output = ' '.join(logs.output)
        self.assertNotIn('SECRET_URL_PROMPT', output); self.assertNotIn('PRIVATE_USER_URL', output)
        self.assertIn('resume_after=' + A, output)
        self.assertEqual(await job.run_scan(AsyncMock(return_value=page(['released'])), after_id=A), 0)

    async def test_empty_scan_and_finalized_skips(self):
        for value in [page(), page(['skipped'])]:
            self.assertEqual(await job.run_scan(AsyncMock(return_value=value)), 0)

    async def test_bad_cursor_outcome_and_unbounded_pages_rejected_without_logging_data(self):
        for value in [page(['SECRET_URL']), page([], 'SECRET_URL'), page(['charged', 'released'])]:
            with self.assertLogs(job.logger, level='ERROR') as logs:
                self.assertEqual(await job.run_scan(AsyncMock(return_value=value), page_size=1), 1)
            self.assertNotIn('SECRET_URL', str(logs.output))
        for kwargs in [{'page_size': 101}, {'max_pages': 0}, {'after_id': 'SECRET_URL'}]:
            reconcile = AsyncMock()
            with self.assertRaises(ValueError): await job.run_scan(reconcile, **kwargs)
            reconcile.assert_not_awaited()


class EntryTests(unittest.TestCase):
    def test_disabled_does_not_start_process_or_import_financial_services(self):
        with patch.object(job.subprocess, 'run') as process:
            self.assertEqual(job.main([]), 2)
        process.assert_not_called()

    def test_supervisor_deadline_and_command_has_no_credentials(self):
        with patch.object(job.subprocess, 'run', return_value=Mock(returncode=0)) as process:
            self.assertEqual(job.main(['--execute', '--max-seconds', '3', '--after-id', A]), 0)
        args, kwargs = process.call_args
        self.assertEqual(kwargs['timeout'], 3)
        self.assertIn('--_worker', args[0]); self.assertIn(A, args[0])

    def test_process_timeout_is_controlled_no_release(self):
        with patch.object(job.subprocess, 'run', side_effect=subprocess.TimeoutExpired('PRIVATE', 1)):
            with self.assertLogs(job.logger, level='ERROR') as logs:
                self.assertEqual(job.main(['--execute']), 124)
        self.assertNotIn('PRIVATE', str(logs.output))

    def test_initialization_error_does_not_print_exception_or_credentials(self):
        import builtins
        original = builtins.__import__
        def private_import(name, *args, **kwargs):
            if name == 'app.services.face_swap_reconciliation': raise RuntimeError('SECRET_CREDENTIAL')
            return original(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=private_import):
            with self.assertLogs(job.logger, level='ERROR') as logs:
                self.assertEqual(job.main(['--execute', '--_worker']), 1)
        self.assertNotIn('SECRET_CREDENTIAL', str(logs.output))
