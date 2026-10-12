package dev.happier.cryptoworker

/**
 * Public, React-free access to the canonical Session crypto primitives.
 * Background and extension consumers use this facade instead of maintaining a
 * second envelope or payload implementation.
 */
public object HappierCryptoWorkerSessionCrypto {
  /** Machine data-key content uses the canonical AES-GCM worker, not Session secretbox. */
  @JvmStatic
  public fun decryptMachinePayload(ciphertextBase64: String, machineDataKeyBase64: String): String? =
    HappierCryptoWorker.decryptAesGcmJsonBatch(listOf(mapOf(
      "encryptedPayloadBase64" to ciphertextBase64,
      "keyBase64" to machineDataKeyBase64,
    ))).firstOrNull()

  @JvmStatic
  public fun openSessionDataKey(
    envelopeBase64: String,
    recipientSecretKeyOrSeedBase64: String,
  ): String? = HappierCryptoWorker.decryptDataKeyEnvelopeV1Batch(listOf(mapOf(
    "envelopeBase64" to envelopeBase64,
    "recipientSecretKeyOrSeedBase64" to recipientSecretKeyOrSeedBase64,
  ))).firstOrNull()

  @JvmStatic
  public fun decryptSessionPayload(
    ciphertextBase64: String,
    sessionDataKeyBase64: String,
  ): String? = HappierCryptoWorker.decryptSecretboxJsonBatch(listOf(mapOf(
    "ciphertextBase64" to ciphertextBase64,
    "keyBase64" to sessionDataKeyBase64,
  ))).firstOrNull()
}
