from app.store import store


def tags_for(item_id):
    """Tags of an item, as a new list the caller may change."""
    found = store.get(item_id)
    if found is None:
        return []
    return list(found)
