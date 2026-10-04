// keystore_nvs.h: where the S3 keeps the pairing key (protocol/frames.md, "Pairing"): its own NVS namespace, nothing else reads it.
// The key is never logged, shown or sent; erasing it is `walkie pair --forget` with the key press on the device.
#pragma once
#include "proto/gate.h"

const proto::KeyStore& nvsKeyStore();
