import { AbiInput } from 'web3-utils';

export interface Abi {
    name: string;
    type: 'function' | 'event';
    inputs: AbiInput[];
    contractName?: string;
    fileName?: string;
    contractFingerprint?: string;
    contractAddress?: string;
    anonymous?: boolean;
}
