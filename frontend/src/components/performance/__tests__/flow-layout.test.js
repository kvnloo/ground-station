import { describe, expect, it } from 'vitest';
import { preserveNodePositions } from '../flow-layout.js';

describe('preserveNodePositions', () => {
    it('keeps manually positioned nodes in place while applying fresh metric data', () => {
        const currentNodes = [
            { id: 'worker', position: { x: 640, y: 120 }, data: { rate: 1 } },
            { id: 'decoder', position: { x: 920, y: 360 }, data: { rate: 2 } },
        ];
        const nextNodes = [
            { id: 'worker', position: { x: 50, y: 50 }, data: { rate: 3 } },
            { id: 'decoder', position: { x: 250, y: 50 }, data: { rate: 4 } },
            { id: 'new-node', position: { x: 450, y: 50 }, data: { rate: 5 } },
        ];

        const nodes = preserveNodePositions(nextNodes, currentNodes);

        expect(nodes).toEqual([
            { id: 'worker', position: { x: 640, y: 120 }, data: { rate: 3 } },
            { id: 'decoder', position: { x: 920, y: 360 }, data: { rate: 4 } },
            { id: 'new-node', position: { x: 450, y: 50 }, data: { rate: 5 } },
        ]);
    });
});
