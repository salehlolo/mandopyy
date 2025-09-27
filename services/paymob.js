const DEFAULT_BASE = 'https://accept.paymob.com';

async function postJson(baseUrl, path, payload) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    const parseError = new Error('Failed to parse Paymob response');
    parseError.cause = error;
    throw parseError;
  }
  if (!response.ok) {
    const message = data?.message || data?.detail || `Paymob error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.response = data;
    throw err;
  }
  return data;
}

function createClient({ apiKey, baseUrl, integrationId, iframeId }) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  return {
    async getAuthToken() {
      if (!apiKey) {
        throw new Error('Paymob API key is not configured');
      }
      const data = await postJson(base, '/api/auth/tokens', { api_key: apiKey });
      if (!data?.token) {
        throw new Error('Paymob authentication token missing in response');
      }
      return data.token;
    },

    async createOrder(authToken, amountCents, merchantOrderId) {
      if (!authToken) {
        throw new Error('Paymob auth token is required to create an order');
      }
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        throw new Error('Paymob amount must be a positive number of cents');
      }
      const payload = {
        auth_token: authToken,
        delivery_needed: false,
        amount_cents: amountCents,
        currency: 'EGP',
        merchant_order_id: merchantOrderId,
        items: []
      };
      const data = await postJson(base, '/api/ecommerce/orders', payload);
      if (!data?.id) {
        throw new Error('Paymob order ID missing from response');
      }
      return data;
    },

    async getPaymentKey(authToken, { orderId, amountCents, billingData, integrationId: overrideIntegrationId }) {
      if (!authToken) {
        throw new Error('Paymob auth token is required to request a payment key');
      }
      const integration = overrideIntegrationId || integrationId;
      if (!integration) {
        throw new Error('Paymob integration ID is not configured');
      }
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        throw new Error('Paymob amount must be a positive number of cents');
      }
      if (!orderId) {
        throw new Error('Paymob order id is required to create a payment key');
      }
      const payload = {
        auth_token: authToken,
        amount_cents: amountCents,
        expiration: 3600,
        order_id: orderId,
        currency: 'EGP',
        integration_id: Number(integration),
        billing_data: billingData
      };
      const data = await postJson(base, '/api/acceptance/payment_keys', payload);
      if (!data?.token) {
        throw new Error('Paymob payment token missing in response');
      }
      return data.token;
    },

    buildIframeUrl(paymentToken) {
      if (!iframeId) {
        throw new Error('Paymob iframe ID is not configured');
      }
      if (!paymentToken) {
        throw new Error('Payment token is required to build the iframe URL');
      }
      return `${base}/api/acceptance/iframes/${iframeId}?payment_token=${paymentToken}`;
    }
  };
}

module.exports = { createClient };
