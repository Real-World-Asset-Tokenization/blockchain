const { ethers } = require("ethers");

/**
 * Commutative pair hash matching OpenZeppelin's Hashes.commutativeKeccak256(bytes32, bytes32)
 */
function hashPair(a, b) {
  const bufA = Buffer.from(a.slice(2), "hex");
  const bufB = Buffer.from(b.slice(2), "hex");
  return bufA.compare(bufB) < 0
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/**
 * Double-hashed leaf matching ProfitDistribution.getLeafHash
 */
function hashLeaf(chainId, contractAddress, assetId, roundId, claimant, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "address", "uint256"],
      [chainId, contractAddress, assetId, roundId, claimant, amount]
    )
  );
  return ethers.keccak256(inner);
}

class MerkleTree {
  constructor(leaves) {
    if (!leaves || leaves.length === 0) {
      throw new Error("Cannot build Merkle tree with 0 leaves");
    }
    this.leaves = [...leaves];
    this.layers = [this.leaves];
    this._buildTree();
  }

  _buildTree() {
    let current = this.layers[0];
    while (current.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          nextLevel.push(hashPair(current[i], current[i + 1]));
        } else {
          // Odd element: promote to next level
          nextLevel.push(current[i]);
        }
      }
      this.layers.push(nextLevel);
      current = nextLevel;
    }
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Invalid leaf index: ${leafIndex}`);
    }

    const proof = [];
    let index = leafIndex;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const pairIndex = isRightNode ? index - 1 : index + 1;

      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }
}

module.exports = {
  hashPair,
  hashLeaf,
  MerkleTree
};
