import "@payrails/web-sdk/payrails-styles.css";
import * as PayrailsSDK from "@payrails/web-sdk";

const statusEl = document.getElementById("status");
const submitButton = document.getElementById("submit-button");
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;
const THREE_DS_SIGNAL_TIMEOUT_MS = 180000;
const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 720;

function setStatus(payload) {
  statusEl.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function resolvePayrails() {
  if (PayrailsSDK?.default?.init) return PayrailsSDK.default;
  if (PayrailsSDK?.Payrails?.init) return PayrailsSDK.Payrails;
  if (PayrailsSDK?.init) return PayrailsSDK;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function open3DSPopup(url) {
  const screenLeft = window.screenLeft ?? window.screenX ?? 0;
  const screenTop = window.screenTop ?? window.screenY ?? 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || screen.width;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || screen.height;
  const left = Math.max(0, Math.round(screenLeft + (viewportWidth - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round(screenTop + (viewportHeight - POPUP_HEIGHT) / 2));
  const features = `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},resizable=yes,scrollbars=yes`;

  const popup = window.open(url, "payrails-3ds", features);
  if (!popup) {
    throw new Error("3DS popup was blocked. Please allow popups for this site and try again.");
  }
  popup.focus?.();
  return popup;
}

function normalizeExecutionPayload(payload) {
  if (payload?.response) return payload;

  const actionRequired = String(payload?.actionRequired || "").toLowerCase();
  return {
    execution: "ok",
    requires3ds: actionRequired === "3ds",
    threeDSUrl: payload?.requiredAction?.href || payload?.links?.["3ds"] || null,
    executionId: payload?.id || null,
    response: payload,
  };
}

async function fetchExecutionStatus(executionId) {
  const statusResp = await fetch(`/api/executions/${encodeURIComponent(executionId)}/status`);
  const statusJson = await statusResp.json().catch(() => ({}));
  if (!statusResp.ok) {
    throw new Error(statusJson.error || statusResp.statusText);
  }
  return normalizeExecutionPayload(statusJson);
}

function waitFor3DSCompletion(popupRef) {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeoutId);
      window.clearInterval(closeCheckId);
    };

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== "payrails-3ds-result") return;
      finish({ reason: "message", result: data.result || "unknown" });
    };

    window.addEventListener("message", onMessage);

    const closeCheckId = window.setInterval(() => {
      if (popupRef?.closed) {
        finish({ reason: "closed" });
      }
    }, 300);

    const timeoutId = window.setTimeout(() => {
      finish({ reason: "timeout" });
    }, THREE_DS_SIGNAL_TIMEOUT_MS);
  });
}

async function pollExecutionStatus(executionId) {
  const startTime = Date.now();
  let lastPayload = null;

  while (Date.now() - startTime <= POLL_TIMEOUT_MS) {
    const payload = await fetchExecutionStatus(executionId);
    lastPayload = payload;

    if (!payload.requires3ds) {
      return { state: "final", payload };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { state: "timeout", payload: lastPayload };
}

async function initPayrails() {
  const Payrails = resolvePayrails();
  if (!Payrails) {
    throw new Error("Payrails SDK not found. Check the import path for @payrails/web-sdk.");
  }

  const initResp = await fetch("/api/payrails/init", { method: "POST" });
  const initJson = await initResp.json().catch(() => ({}));
  if (!initResp.ok) {
    throw new Error(initJson.error || initResp.statusText);
  }

  const environment = window.__PAYRAILS_ENV__ || "TEST";
  console.log(`Initializing Payrails in ${environment} environment... with config ${initJson ? JSON.stringify(initJson) : "N/A"}`);
  const payrailsClient = await Payrails.init(initJson, { environment });

  const cardForm = payrailsClient.cardForm();
  cardForm.mount("#card-form-container");

  return { cardForm };
}

async function handleSubmit(cardForm) {
  submitButton.disabled = true;
  setStatus("Tokenizing card...");

  try {
    const instrument = await cardForm.tokenize();

    const instrumentId =
      instrument?.id || instrument?.instrumentId || instrument?.paymentInstrumentId;

    if (!instrumentId) {
      throw new Error("No instrument ID returned from tokenization.");
    }

    setStatus({ tokenization: "ok", instrumentId });

    const execResp = await fetch("/api/executions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrumentId, instrument }),
    });

    const execJson = await execResp.json().catch(() => ({}));
    if (!execResp.ok) {
      throw new Error(execJson.error || execResp.statusText);
    }

    const execution = normalizeExecutionPayload(execJson);
    if (!execution.requires3ds) {
      setStatus({ execution: "ok", response: execution.response });
      return;
    }

    if (!execution.threeDSUrl) {
      throw new Error("3DS was required but no redirect URL was returned.");
    }
    if (!execution.executionId) {
      throw new Error("3DS was required but no execution ID was returned.");
    }

    setStatus({
      execution: "pending",
      stage: "3ds_required",
      executionId: execution.executionId,
      message: "3DS challenge required. Complete authentication in the popup window.",
      response: execution.response,
    });

    const popupRef = open3DSPopup(execution.threeDSUrl);
    const completionSignal = await waitFor3DSCompletion(popupRef);
    setStatus({
      execution: "pending",
      stage: "3ds_verifying",
      executionId: execution.executionId,
      message: "3DS challenge completed. Verifying authorization status...",
      completionSignal,
    });
    const pollResult = await pollExecutionStatus(execution.executionId);

    if (pollResult.state === "final") {
      try {
        if (!popupRef.closed) popupRef.close();
      } catch {
        // Ignore close issues and continue.
      }
      setStatus({ execution: "ok", response: pollResult.payload.response });
      return;
    }

    setStatus({
      execution: "pending",
      reason: "timeout",
      executionId: execution.executionId,
      message: "3DS authentication is still pending. Check back shortly.",
      response: pollResult.payload?.response || execution.response,
    });
  } catch (err) {
    setStatus({ error: err?.message || String(err) });
  } finally {
    try {
      cardForm.hide({ reset: true });
      cardForm.show();
    } catch {
      // Ignore reset errors and still re-enable submit.
    }
    submitButton.disabled = false;
  }
}

(async () => {
  try {
    setStatus("Initializing Payrails...");
    const { cardForm } = await initPayrails();
    setStatus("Ready.");

    submitButton.addEventListener("click", () => handleSubmit(cardForm));
  } catch (err) {
    setStatus({ error: err?.message || String(err) });
  }
})();
