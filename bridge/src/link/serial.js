// Finds the S3 by its USB IDs and opens it without resetting it. With hupcl and rtscts off, Windows keeps
// DTR and RTS low; on the ESP32-S3's USB-Serial-JTAG a raised RTS holds the chip in reset.
import { SerialPort } from 'serialport';

export const S3_USB = Object.freeze({ vendorId: '303a', productId: '1001' });

export async function findS3Port() {
  const ports = await SerialPort.list();
  const hit = ports.find(
    (p) => p.vendorId?.toLowerCase() === S3_USB.vendorId && p.productId?.toLowerCase() === S3_USB.productId,
  );
  return hit ? hit.path : null;
}

export function openS3Port(path) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200, hupcl: false, rtscts: false, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}
