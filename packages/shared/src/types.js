// JSDoc typedefs (documentation only).
/** @typedef {Object} Job
 *  @property {string} jobId @property {string} cluster @property {string} name
 *  @property {string} user @property {string} account @property {string} partition
 *  @property {string} state @property {string} reason @property {number} priority
 *  @property {number} pendingSeconds @property {number} elapsedSeconds
 *  @property {number} timelimitSeconds @property {number} reqCpus @property {string} reqMem
 *  @property {string} wckey @property {string} workdir @property {string} nodelist
 *  @property {string} dependency */
/** @typedef {Object} Diagnosis
 *  @property {string} jobId @property {string} category @property {string} explain
 *  @property {boolean} held @property {boolean} starved @property {Object[]} findings */
/** @typedef {Object} Eta
 *  @property {number} etaStartSeconds @property {number} etaFinishSeconds
 *  @property {number} confidence @property {string} basis */
export {};
