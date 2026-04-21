const fs = require('fs').promises;
const path = require('path');

async function atomicWriteText(filePath, content, {
  writeFile = fs.writeFile,
  rename = fs.rename,
  unlink = fs.unlink
} = {}) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  let tempWritten = false;
  try {
    await writeFile(tempPath, content, 'utf8');
    tempWritten = true;
    await rename(tempPath, filePath);
  } catch (error) {
    if (tempWritten) {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
    throw error;
  }
}

module.exports = {
  atomicWriteText
};
