/**
 * Port Allocator (Phase 7)
 *
 * Manages dynamic port allocation for translator agent child processes.
 * Each agent needs a unique botPagePort and healthPort.
 */

import { createLogger } from '../logger';

const logger = createLogger('PortAllocator');

export class PortAllocator {
  private botPagePortBase: number;
  private healthPortBase: number;
  private allocatedBotPorts: Set<number> = new Set();
  private allocatedHealthPorts: Set<number> = new Set();

  constructor(botPagePortBase: number, healthPortBase: number) {
    this.botPagePortBase = botPagePortBase;
    this.healthPortBase = healthPortBase;
    logger.info('PortAllocator initialized', { botPagePortBase, healthPortBase });
  }

  /**
   * Allocates a pair of ports (botPagePort, healthPort).
   * Finds the next available offset from each base.
   */
  allocate(): { botPagePort: number; healthPort: number } {
    const offset = this.findNextOffset();
    const botPagePort = this.botPagePortBase + offset;
    const healthPort = this.healthPortBase + offset;

    this.allocatedBotPorts.add(botPagePort);
    this.allocatedHealthPorts.add(healthPort);

    logger.info('Ports allocated', { botPagePort, healthPort, offset });
    return { botPagePort, healthPort };
  }

  /**
   * Releases a pair of ports back to the pool.
   */
  release(botPagePort: number, healthPort: number): void {
    this.allocatedBotPorts.delete(botPagePort);
    this.allocatedHealthPorts.delete(healthPort);
    logger.info('Ports released', { botPagePort, healthPort });
  }

  /**
   * Finds the next available offset where both ports are free.
   */
  private findNextOffset(): number {
    for (let offset = 0; offset < 100; offset++) {
      const botPort = this.botPagePortBase + offset;
      const healthPort = this.healthPortBase + offset;
      if (!this.allocatedBotPorts.has(botPort) && !this.allocatedHealthPorts.has(healthPort)) {
        return offset;
      }
    }
    throw new Error('No available ports - all 100 offsets exhausted');
  }

  /**
   * Returns the number of currently allocated port pairs.
   */
  getAllocatedCount(): number {
    return this.allocatedBotPorts.size;
  }
}
