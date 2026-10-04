// crypto_mbedtls.h: the primitives of proto/crypto.h on the S3's mbedtls (and its AES hardware).
#pragma once
#include "proto/crypto.h"

// The functions share one GCM context, so they must not run at the same time: usblink.cpp calls them all under its TX lock.
const proto::Crypto& mbedtlsCrypto();
