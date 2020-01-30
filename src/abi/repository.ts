import { readdir, readFile, stat } from 'fs-extra';
import { basename, join } from 'path';
import { AbiCoder } from 'web3-eth-abi';
import { AbiItem } from 'web3-utils';
import { RawLogResponse } from '../eth/responses';
import { createModuleDebug, TRACE_ENABLED } from '../utils/debug';
import { ManagedResource } from '../utils/resource';
import { Abi } from './abi';
import { computeContractFingerprint } from './contract';
import { DecodedFunctionCall, DecodedLogEvent, decodeFunctionCall, decodeLogEvent } from './decode';
import { computeSignature, computeSignatureHash } from './signature';

const { debug, warn, trace } = createModuleDebug('abi');

interface TruffleBuild {
    contractName: string;
    abi: AbiItem[];
    networks?: {
        [id: string]: {
            address: string;
        };
    };
}

export function isAbiArray(obj: any): obj is AbiItem[] {
    return Array.isArray(obj);
}

export function isTruffleBuildFile(obj: any): obj is TruffleBuild {
    return typeof obj === 'object' && typeof obj.contractName === 'string' && Array.isArray(obj.abi);
}

interface AbiMatch {
    name: string;
    candidates: Abi[];
}

export interface ContractAbi {
    contractName: string;
    fileName: string;
}

export class AbiRepository implements ManagedResource {
    private signatures: Map<string, AbiMatch> = new Map();
    private contractsByFingerprint: Map<string, ContractAbi> = new Map();
    private contractsByAddress: Map<string, ContractAbi> = new Map();
    private abiCoder: AbiCoder = require('web3-eth-abi');

    public async loadAbiDir(
        dir: string,
        { recursive = true, fileNameSuffix = '.json' }: { recursive?: boolean; fileNameSuffix?: string } = {}
    ): Promise<number> {
        debug('Searching for ABI files in %s', dir);
        const dirContents = await readdir(dir).catch(e =>
            Promise.reject(new Error(`Failed to load ABIs from directory ${dir}: ${e}`))
        );
        const subdirs = [];
        let loaded = 0;
        for (const f of dirContents) {
            const full = join(dir, f);
            const s = await stat(full);
            if (s.isDirectory() && recursive) {
                subdirs.push(join(dir, f));
            } else if (s.isFile() && f.endsWith(fileNameSuffix)) {
                await this.loadAbiFile(full);
                loaded++;
            }
        }
        const counts = await Promise.all(subdirs.map(sub => this.loadAbiDir(sub, { recursive, fileNameSuffix })));
        return loaded + counts.reduce((a, b) => a + b, 0);
    }

    public async loadAbiFile(path: string) {
        const contents = await readFile(path, { encoding: 'utf-8' });
        const data = JSON.parse(contents);
        this.loadAbi(data, path);
    }

    public loadAbi(abiData: any, fileName: string) {
        debug('Loading ABI %s', fileName);
        let abis: AbiItem[];
        let contractName: string;
        let contractAddress: string | undefined;
        if (isTruffleBuildFile(abiData)) {
            abis = abiData.abi;
            contractName =
                abiData.contractName ||
                // Fall back to file name without file extension
                basename(fileName).split('.', 1)[0];
        } else if (isAbiArray(abiData)) {
            abis = abiData;
            contractName = basename(fileName).split('.', 1)[0];
        } else {
            warn('Invalid contents of ABI file %s', fileName);
            return;
        }

        const items = abis
            .filter(abi => (abi.type === 'function' || abi.type === 'event') && abi.name != null)
            .map(item => ({
                item,
                sig: computeSignature({ name: item.name!, inputs: item.inputs ?? [], type: 'function' }),
            }));

        const functions = items
            .filter(i => i.item.type === 'function')
            .map(i => i.sig)
            .sort();
        const events = items
            .filter(i => i.item.type === 'event')
            .map(i => i.sig)
            .sort();

        const contractFingerprint = computeContractFingerprint({ functions, events });

        for (const i of items) {
            const { sig: sig, item } = i;
            const sigHash = computeSignatureHash(sig, item.type as 'function' | 'event');
            debug('Signature for %s %s => %s', item.type, sig, sigHash);
            let match: AbiMatch | undefined = this.signatures.get(sigHash);
            if (match == null) {
                match = {
                    name: sig,
                    candidates: [],
                };
                this.signatures.set(sigHash, match);
            } else {
                if (match.name !== sig) {
                    throw new Error(
                        `ABI signature collision for ${item.type} ${item.name} (saw names "${sig}" and ${match.name})`
                    );
                }
            }
            match.candidates.push({
                name: item.name!,
                type: item.type as 'function' | 'event',
                inputs: item.inputs ?? [],
                contractName,
                contractFingerprint,
                contractAddress,
                fileName,
            });
        }

        if (contractFingerprint != null) {
            debug('Computed contract fingerprint %s for contract signature %s', contractFingerprint, contractName);
            this.contractsByFingerprint.set(contractFingerprint, {
                contractName,
                fileName,
            });
        }
    }

    public get signatureCount(): number {
        return this.signatures.size;
    }

    public getMatchingAbi(signatureHash: string): AbiMatch | undefined {
        return this.signatures.get(signatureHash);
    }

    public getMatchingSignatureName(signatureHash: string): string | undefined {
        return this.signatures.get(signatureHash)?.name;
    }

    public getContractByFingerprint(fingerprint: string): ContractAbi | undefined {
        return this.contractsByFingerprint.get(fingerprint);
    }

    public getContractByAddress(address: string): ContractAbi | undefined {
        return this.contractsByAddress.get(address?.toLowerCase());
    }

    public decodeFunctionCall(data: string, contractFingerprint?: string): DecodedFunctionCall | undefined {
        const sigHash = data.slice(2, 10);
        const match = this.signatures.get(sigHash);
        if (match == null) {
            return;
        }
        const abi = match.candidates.find(
            a => contractFingerprint == null || a.contractFingerprint === contractFingerprint
        );
        if (abi != null) {
            debug(
                'Found ABI %s matching fingerprint %s from contract %s',
                match.name,
                contractFingerprint,
                abi.contractName
            );
            return decodeFunctionCall(data, abi, match.name, this.abiCoder);
        } else if (TRACE_ENABLED) {
            trace(
                'No matching contract found for method signature %s hash %s and contract fingerprint %s',
                match.name,
                sigHash,
                contractFingerprint
            );
        }
        return;
    }

    public decodeLogEvent(logEvent: RawLogResponse, contractFingerprint?: string): DecodedLogEvent | undefined {
        if (!Array.isArray(logEvent.topics) || logEvent.topics.length === 0) {
            debug(
                'No topics in log event tx=%s idx=%s - nothing to decode',
                logEvent.transactionHash,
                logEvent.logIndex
            );
            return;
        }
        const sigHash = logEvent.topics[0].slice(2);
        const match = this.signatures.get(sigHash);
        if (match != null) {
            const abi = match.candidates.find(c => c.contractFingerprint === contractFingerprint);
            if (abi != null) {
                debug('Found ABI %s matching fingerprint from contract %s', abi.name, abi.contractName);
                const { data, topics } = logEvent;
                return decodeLogEvent(data, topics, abi, match.name, this.abiCoder);
            } else if (TRACE_ENABLED) {
                trace(
                    'No matching contract found for log event signature %s (hash %s) and contract fingerprint %s',
                    match.name,
                    sigHash,
                    contractFingerprint
                );
            }
        }
        return;
    }

    public async shutdown() {
        this.signatures.clear();
    }
}
