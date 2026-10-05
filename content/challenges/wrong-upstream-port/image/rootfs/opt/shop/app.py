"""Small practice service. Responses come from PostgreSQL, not scenario scripts."""

import os
from contextlib import closing
from uuid import uuid4

import psycopg2
from flask import Flask, jsonify, request

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4096


def connect():
    return psycopg2.connect(os.environ["DATABASE_DSN"])


@app.get("/")
def index():
    return "<h1>Storefront</h1><p>Checkout service</p>\n"


@app.post("/api/checkout")
def checkout():
    if request.content_length and request.content_length > app.config["MAX_CONTENT_LENGTH"]:
        return jsonify(error="checkout_too_large"), 413
    payload = request.get_json(silent=True) if request.content_length else {}
    if not isinstance(payload, dict) or set(payload) - {"reference"}:
        return jsonify(error="invalid_checkout"), 400
    reference = payload.get("reference", uuid4().hex)
    if not isinstance(reference, str) or not 1 <= len(reference) <= 128:
        return jsonify(error="invalid_reference"), 400

    order = {"id": uuid4().hex, "reference": reference, "status": "confirmed"}
    with closing(connect()) as connection, connection, connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO orders (id, reference, status) VALUES (%s, %s, %s)",
            (order["id"], order["reference"], order["status"]),
        )
    return jsonify(order), 201


@app.get("/api/orders/<order_id>")
def get_order(order_id):
    if len(order_id) > 128:
        return jsonify(error="order_not_found"), 404
    with closing(connect()) as connection, connection, connection.cursor() as cursor:
        cursor.execute("SELECT id, reference, status FROM orders WHERE id = %s", (order_id,))
        row = cursor.fetchone()
    if row is None:
        return jsonify(error="order_not_found"), 404
    return jsonify(id=row[0], reference=row[1], status=row[2])


@app.errorhandler(psycopg2.Error)
def database_error(error):
    app.logger.warning("Database request failed: %s", type(error).__name__)
    return jsonify(error="database_unavailable"), 503
