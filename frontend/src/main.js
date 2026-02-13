import "@payrails/web-sdk/payrails-styles.css";
import * as PayrailsSDK from "@payrails/web-sdk";

const statusEl = document.getElementById("status");
const submitButton = document.getElementById("submit-button");

function setStatus(payload) {
  statusEl.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function resolvePayrails() {
  if (PayrailsSDK?.default?.init) return PayrailsSDK.default;
  if (PayrailsSDK?.Payrails?.init) return PayrailsSDK.Payrails;
  if (PayrailsSDK?.init) return PayrailsSDK;
  return null;
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
  const payrailsClient = await Payrails.init(initJson, { environment });

  const cardForm = payrailsClient.cardForm();
  cardForm.mount("#card-form-container");

  return { cardForm };
}

async function handleSubmit(cardForm) {
  submitButton.disabled = true;
  setStatus("Tokenizing card...");

  try {
    const instrument = await cardForm.collectValues();

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

    setStatus({ execution: "ok", response: execJson });
  } catch (err) {
    setStatus({ error: err?.message || String(err) });
  } finally {
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
