import json
import os
import secrets
import time
import uuid
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

app = Flask(__name__)


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


_AUTH_CACHE = {"token": None, "token_type": "Bearer", "expires_at": 0.0}


def _parse_json_env(var_name: str) -> dict:
    raw = os.environ.get(var_name, "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        app.logger.warning("Invalid JSON in %s; ignoring.", var_name)
        return {}


def _oauth_configured() -> bool:
    return all(
        [
            os.environ.get("PAYRAILS_AUTH_URL", "").strip(),
            os.environ.get("PAYRAILS_CLIENT_ID", "").strip(),
            os.environ.get("PAYRAILS_API_KEY", "").strip(),
        ]
    )


def _fetch_oauth_token() -> dict:
    url = _build_auth_url()
    if not url:
        raise AuthError("PAYRAILS_AUTH_URL and PAYRAILS_CLIENT_ID must be set", 500)

    api_key = os.environ.get("PAYRAILS_API_KEY", "").strip()
    if not api_key:
        raise AuthError("PAYRAILS_API_KEY is not set", 500)

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-api-key": api_key,
    }

    try:
        resp = requests.post(url, headers=headers, timeout=30)
    except requests.RequestException as exc:
        raise AuthError(str(exc), 502) from exc

    if not resp.ok:
        raise AuthError(resp.text or resp.reason, 502)

    try:
        payload = resp.json()
    except ValueError as exc:
        raise AuthError("Invalid JSON from Payrails auth endpoint", 502) from exc

    access_token = payload.get("access_token")
    if not access_token:
        raise AuthError("Payrails auth response missing access_token", 502)

    return {
        "access_token": access_token,
        "token_type": payload.get("token_type") or "Bearer",
        "expires_in": payload.get("expires_in") or 0,
    }


def _get_oauth_token() -> tuple[str, str]:
    now = time.time()
    if _AUTH_CACHE["token"] and now < _AUTH_CACHE["expires_at"]:
        return _AUTH_CACHE["token_type"], _AUTH_CACHE["token"]

    token_data = _fetch_oauth_token()
    expires_in = 0
    try:
        expires_in = int(token_data.get("expires_in") or 0)
    except (TypeError, ValueError):
        expires_in = 0

    # Refresh a bit early to avoid edge-of-expiry failures.
    refresh_window = 30
    expires_at = now + max(expires_in - refresh_window, 0)

    _AUTH_CACHE.update(
        {
            "token": token_data["access_token"],
            "token_type": token_data["token_type"],
            "expires_at": expires_at,
        }
    )

    return _AUTH_CACHE["token_type"], _AUTH_CACHE["token"]


def _generate_holder_reference() -> str:
    # Generate "cus_<digits>" with up to 16 digits.
    digits = secrets.randbelow(10**16 - 1) + 1
    return f"cus_{digits}"


def _build_headers() -> dict:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if not _oauth_configured():
        raise AuthError(
            "OAuth is required. Set PAYRAILS_AUTH_URL, PAYRAILS_CLIENT_ID, and PAYRAILS_API_KEY.",
            500,
        )

    token_type, token = _get_oauth_token()
    headers["Authorization"] = f"{token_type} {token}".strip()
    return headers


def _proxy_response(resp: requests.Response):
    content_type = resp.headers.get("Content-Type", "application/json")
    print(f"Proxying response with status {resp.status_code} and content type {content_type} and body {resp.text}")
    return resp.text, resp.status_code, {"Content-Type": content_type}


def _build_auth_url() -> str:
    base_url = os.environ.get("PAYRAILS_AUTH_URL", "").strip()
    client_id = os.environ.get("PAYRAILS_CLIENT_ID", "").strip()
    if not base_url or not client_id:
        return ""
    if "{clientId}" in base_url:
        return base_url.replace("{clientId}", client_id)
    if base_url.endswith("/"):
        return f"{base_url}{client_id}"
    return f"{base_url}/{client_id}"


@app.get("/")
def index():
    payrails_environment = os.environ.get("PAYRAILS_ENVIRONMENT", "TEST")
    return render_template("index.html", payrails_environment=payrails_environment)


@app.post("/api/payrails/init")
def payrails_init():
    url = os.environ.get("PAYRAILS_CLIENT_INIT_URL", "").strip()
    if not url:
        return jsonify({"error": "PAYRAILS_CLIENT_INIT_URL is not set"}), 500

    payload = {
        "type": "tokenization",
        "holderReference": _generate_holder_reference(),
    }
    # payload.update(_parse_json_env("PAYRAILS_INIT_EXTRA_JSON"))

    try:
        headers = _build_headers()
        headers["x-idempotency-key"] = str(uuid.uuid4())
        resp = requests.post(url, json=payload, headers=headers, timeout=30)
    except AuthError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502

    return _proxy_response(resp)


@app.post("/api/executions")
def create_execution():
    url = os.environ.get("PAYRAILS_EXECUTION_URL", "").strip()
    if not url:
        return jsonify({"error": "PAYRAILS_EXECUTION_URL is not set"}), 500

    data = request.get_json(silent=True) or {}
    instrument_id = data.get("instrumentId")
    holder_ref = data.get("instrument").get("holderReference")

    if not instrument_id:
        return jsonify({"error": "instrumentId is required"}), 400

    if not holder_ref:
        return jsonify({"error": "holderReference is required"}), 400

    prefix = os.environ.get("PAYRAILS_MERCHANT_REFERENCE_PREFIX", "demo")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    merchant_reference = f"{prefix}-{timestamp}-{uuid.uuid4().hex[:8]}"

    amount = {
        "value": "10.00",
        "currency": "USD",
    }

    payload = {
        "merchantReference": merchant_reference,
        "holderReference": holder_ref,
        "initialActions": [
            {
                "action": "authorize",
                "body": {
                    "amount": {
                        "value": amount["value"],
                        "currency": amount["currency"],
                    },
                    "returnInfo": {
                        "success": "https://example.com/success",
                        "cancel": "https://example.com/cancel",
                        "error": "https://example.com/error",
                        "pending": "https://example.com/pending",
                    },
                    "paymentComposition": [
                        {
                            "paymentMethodCode": "card",
                            "integrationType": "api",
                            "amount": {
                                "value": amount["value"],
                                "currency": amount["currency"],
                            },
                            "paymentInstrumentId": instrument_id,
                            "storeInstrument": False,
                        }
                    ],
                }
            }
        ],
    }

    payload.update(_parse_json_env("PAYRAILS_EXECUTION_EXTRA_JSON"))

    try:
        headers = _build_headers()
        headers["x-idempotency-key"] = str(uuid.uuid4())
        resp = requests.post(url, json=payload, headers=headers, timeout=30)
        print(resp)
    except AuthError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502

    return _proxy_response(resp)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
