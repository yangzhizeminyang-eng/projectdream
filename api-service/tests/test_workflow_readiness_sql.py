import pymysql

from app.database import MySQLDatabase


def test_workflow_asset_query_escapes_like_wildcards_for_pymysql():
    connection = pymysql.connections.Connection(defer_connect=True)
    try:
        query = MySQLDatabase.workflow_asset_nodes_query()
        rendered = connection.cursor().mogrify(query, (21,))
    finally:
        connection.close()

    assert "/mock-assets/" in rendered
    assert "project_id = 21" in rendered
