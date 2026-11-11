"""Per-invocation SDK retry state, with unchanged Firestore transaction policy."""
from functools import wraps
from typing import Callable, ParamSpec, TypeVar

from firebase_admin import firestore

P = ParamSpec("P")
R = TypeVar("R")


def isolated_transactional(function: Callable[P, R]) -> Callable[P, R]:
    """Never share the SDK's mutable retry_id/current_id across invocations.

    Only the stateless Python function is retained by this decorator. The SDK
    wrapper is constructed for each call and retained for that call's retries.
    The caller still supplies its own transaction; SDK defaults remain intact.
    """
    @wraps(function)
    def run(*args: P.args, **kwargs: P.kwargs) -> R:
        return firestore.transactional(function)(*args, **kwargs)

    return run
