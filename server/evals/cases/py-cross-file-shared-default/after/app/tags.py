from app.store import store

# Most items have no tags; reuse one empty list instead of allocating.
_NO_TAGS = []


def tags_for(item_id):
    """Tags of an item, as a new list the caller may change."""
    found = store.get(item_id)
    if found is None:
        return _NO_TAGS
    return list(found)
