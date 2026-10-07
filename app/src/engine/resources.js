// Copies MuseScore's runtime resources (fonts, styles, instrument data,
// articulation profiles) into an Emscripten file system at the paths the C++
// code expects: Qt resource paths like ":/fonts/leland/Leland.otf" are opened
// as relative paths, and the working directory is "/".

export function mkdirs(FS, dir) {
    let cur = "";
    for (const part of dir.split("/").filter(Boolean)) {
        cur += "/" + part;
        try {
            FS.mkdir(cur);
        } catch (e) {
            // exists
        }
    }
}

export function writeFile(FS, path, bytes) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) {
        mkdirs(FS, dir);
    }
    FS.writeFile(path, bytes);
}

// manifest: [{path, size}], fetchBytes(path) -> Promise<Uint8Array>
export async function installResources(FS, manifest, fetchBytes, onProgress) {
    let done = 0;
    await Promise.all(manifest.map(async (entry) => {
        const bytes = await fetchBytes(entry.path);
        writeFile(FS, "/:/" + entry.path, bytes);
        done++;
        if (onProgress) {
            onProgress(done, manifest.length);
        }
    }));
}
