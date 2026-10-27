from app.tags import tags_for


def labels(item_id, overdue):
    result = tags_for(item_id)
    if overdue:
        result.append("overdue")
    return result
