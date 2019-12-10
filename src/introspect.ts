import { EthereumClient } from './eth/client';
import { clientVersion } from './eth/requests';
import { createModuleDebug } from './utils/debug';
import { NodePlatformAdapter } from './platforms';
import { GenericNodeAdapter } from './platforms/generic';
import { GethAdapter } from './platforms/geth';
import { ParityAdapter } from './platforms/parity';
import { QuorumAdapter } from './platforms/quorum';

const { debug, info, error } = createModuleDebug('introspect');

export function createNodeAdapter(eth: EthereumClient, version: string): NodePlatformAdapter {
    if (version.startsWith('Geth/')) {
        debug('Detected geth node');
        if (version.includes('quorum')) {
            debug('Found "quorum" in version string - using Quroum adapter');
            const adapter = new QuorumAdapter(version);
            return adapter;
        } else {
            const adapter = new GethAdapter(version);
            return adapter;
        }
    }
    if (version.startsWith('Parity//')) {
        debug('Detected parity node');
        return new ParityAdapter(version);
    }
    debug('No specific support for given node type, falling bakc to generic adapter');
    return new GenericNodeAdapter(version);
}

export async function introspectTargetNodePlatform(eth: EthereumClient): Promise<NodePlatformAdapter> {
    debug(`Introspecting target ethereum node`);
    const version = await eth.request(clientVersion());
    info('Retrieved ethereum node version: %s', version);

    const adapter = createNodeAdapter(eth, version);
    if (typeof adapter.initialize === 'function') {
        debug('Initializing node platform adatper: %s', adapter.name);
        try {
            await adapter.initialize(eth);
        } catch (e) {
            error('Failed to initialize node platform adapter:', e);
            throw new Error(`Failed initialize node platform adapter ${adapter.name}`);
        }
    }
    return adapter;
}