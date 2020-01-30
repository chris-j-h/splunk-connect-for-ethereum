import { debug as createDebug } from 'debug';
import { createWriteStream, readFile } from 'fs-extra';
import { createGzip } from 'zlib';
import { computeSignatureHash } from '../src/abi/repository';

const debug = createDebug('buildsigs');
debug.enabled = true;

async function readSignatureFile(file: string): Promise<Iterable<string>> {
    debug('Loading signatures from %o', file);
    const allSignatures = [];
    const d = await readFile(file, { encoding: 'utf-8' });
    for (const line of d.split('\n')) {
        if (line) {
            allSignatures.push(line);
        }
    }
    return allSignatures;
}

async function buildSignatureFile(sourceFile: string, destFile: string, type: 'function' | 'event') {
    const fns = await readSignatureFile(sourceFile);
    const sigHashMap = new Map<string, string[]>();
    for (const fnSig of fns) {
        const hash = computeSignatureHash(fnSig, type);
        if (sigHashMap.has(hash)) {
            const newSigs = [fnSig, ...sigHashMap.get(hash)!];
            debug('WARN: hash collision detected hash=%o | %s signatures: %o', hash, type, newSigs);
            sigHashMap.set(hash, newSigs);
        } else {
            sigHashMap.set(hash, [fnSig]);
        }
    }

    let count = 0;
    await new Promise((resolve, reject) => {
        const stream = createGzip({ level: 9 });
        const dest = createWriteStream(destFile);
        stream.pipe(dest);
        stream.once('end', () => {
            resolve();
        });
        stream.once('error', e => reject(e));
        for (const [hash, sigs] of sigHashMap.entries()) {
            stream.write(`${hash}:${sigs.join(':')}\n`, 'utf-8');
            count++;
        }
        stream.end();
    });
    debug('Write %o signatures to %s', count, destFile);
}

async function main() {
    await buildSignatureFile('data/function_signatures.txt', 'data/fns.abisigs.gz', 'function');
    await buildSignatureFile('data/event_signatures.txt', 'data/evts.abisigs.gz', 'event');
}

main().catch(e => {
    debug('FATAL', e);
    process.exit(1);
});
