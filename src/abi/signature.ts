import { sha3 } from 'web3-utils';
import { Abi } from './abi';

export function computeSignature(abi: Abi) {
    if (abi.name == null) {
        throw new Error('Cannot add ABI item without name');
    }
    return `${abi.name}(${(abi.inputs ?? []).map(i => i.type).join(',')})`;
}

export function parseSignature(signature: string, type: 'function' | 'event'): Abi {
    const openParen = signature.indexOf('(');
    if (openParen < 1) {
        throw new Error(`Invalid signature: ${signature}`);
    }
    const name = signature.slice(0, openParen);

    return {
        type,
        name,
        inputs: [],
    };
}

export function computeSignatureHash(sigName: string, type: 'event' | 'function'): string {
    const hash = sha3(sigName);
    return type === 'event' ? hash.slice(2) : hash.slice(2, 10);
}
