# eziee contracts

`EzieeTestToken` (EZT): a valueless TEST ERC-20 for Arc testnet (chain 5042002). Users send it to a treasury to buy app credit; the app prices it offchain at a fixed rate. Testers mint it from an open faucet (`claim()`, once per cooldown per address). Owner (Ownable2Step) can `mint` and `setFaucet`.

## Setup (clean clone)

Dependencies are managed by Soldeer (locked in `soldeer.lock`, not committed under `dependencies/`).

```sh
cd contracts
forge soldeer install   # restores OpenZeppelin 5.1.0 + forge-std
forge build
forge test
forge fmt
```

## Deploy

Optional env: `OWNER` (default: the sender), `FAUCET_AMOUNT` (default 1000 ether), `FAUCET_COOLDOWN` (default 1 days).

```sh
# simulate only
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.network --sender <address>
# deploy
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.network --account <keystore-name> --broadcast
```

## Verify with cast

```sh
export RPC=https://rpc.testnet.arc.network TOKEN=<deployed address>
cast code $TOKEN --rpc-url $RPC | head -c 20
cast call $TOKEN "symbol()(string)" --rpc-url $RPC
cast call $TOKEN "decimals()(uint8)" --rpc-url $RPC
cast call $TOKEN "owner()(address)" --rpc-url $RPC
cast call $TOKEN "faucetAmount()(uint256)" --rpc-url $RPC
cast call $TOKEN "nextClaimAt(address)(uint256)" <wallet> --rpc-url $RPC
```
