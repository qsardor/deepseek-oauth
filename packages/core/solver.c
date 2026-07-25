#include <stdint.h>

#define RATE 136
#define LANES 25

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};

static const int RHO[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};

static inline uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

static void keccak_f1600(uint64_t state[LANES], int startRound, int endRound) {
    for (int r = startRound; r < endRound; r++) {
        uint64_t C[5];
        for (int x = 0; x < 5; x++) C[x] = state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20];
        for (int x = 0; x < 5; x++) {
            uint64_t d = C[(x+4)%5] ^ rotl64(C[(x+1)%5], 1);
            for (int y = 0; y < 5; y++) state[x+5*y] ^= d;
        }
        int x = 1, y = 0;
        uint64_t current = state[x+5*y];
        for (int t = 0; t < 24; t++) {
            int nx = y, ny = (2*x+3*y) % 5;
            uint64_t tmp = state[nx+5*ny];
            state[nx+5*ny] = rotl64(current, RHO[x+5*y]);
            current = tmp;
            x = nx; y = ny;
        }
        for (int y = 0; y < 5; y++) {
            int iy = 5*y;
            uint64_t l0 = state[iy], l1 = state[1+iy], l2 = state[2+iy], l3 = state[3+iy], l4 = state[4+iy];
            state[iy] = l0 ^ (~l1 & l2);
            state[1+iy] = l1 ^ (~l2 & l3);
            state[2+iy] = l2 ^ (~l3 & l4);
            state[3+iy] = l3 ^ (~l4 & l0);
            state[4+iy] = l4 ^ (~l0 & l1);
        }
        state[0] ^= RC[r];
    }
}

__attribute__((export_name("deepseek_hash")))
void deepseek_hash(const uint8_t* input, int inputLen, uint8_t* output) {
    uint64_t state[LANES] = {0};
    int k = (RATE - ((inputLen + 2) % RATE)) % RATE;
    int paddedLen = inputLen + 2 + k;

    for (int off = 0; off < paddedLen; off += RATE) {
        int blockLen = (off + RATE <= paddedLen) ? RATE : (paddedLen - off);

        for (int j = 0; j < blockLen; j++) {
            int pos = off + j;
            if (pos < inputLen) {
                state[j/8] ^= (uint64_t)input[pos] << (8 * (j % 8));
            } else if (pos == inputLen) {
                state[j/8] ^= (uint64_t)0x06 << (8 * (j % 8));
            } else if (pos < paddedLen - 1) {
            } else {
                state[j/8] ^= (uint64_t)0x80 << (8 * (j % 8));
            }
        }
        keccak_f1600(state, 1, 24);
    }

    for (int i = 0; i < 32; i++) {
        output[i] = (uint8_t)(state[i/8] >> (8 * (i % 8)));
    }
}

__attribute__((export_name("solve_pow")))
int solve_pow(
    const uint8_t* salt, int saltLen,
    int64_t expireAt,
    int32_t difficulty,
    const uint8_t* target, int targetLen
) {
    uint8_t prefix[256];
    int pl = saltLen;
    for (int i = 0; i < saltLen; i++) prefix[i] = salt[i];
    prefix[pl++] = '_';

    char numBuf[32];
    int nb = 0;
    int64_t t = expireAt;
    if (t < 0) { prefix[pl++] = '-'; t = -t; }
    if (t == 0) { prefix[pl++] = '0'; }
    else {
        int ds = pl;
        while (t > 0) { numBuf[nb++] = '0' + (int)(t % 10); t /= 10; }
        for (int i = nb - 1; i >= 0; i--) prefix[ds++] = numBuf[i];
        pl = ds;
    }
    prefix[pl++] = '_';

    uint8_t targetBytes[32];
    for (int i = 0; i < 32; i++) {
        char hi = target[i*2], lo = target[i*2+1];
        int hv = (hi >= 'a') ? hi-'a'+10 : hi-'0';
        int lv = (lo >= 'a') ? lo-'a'+10 : lo-'0';
        targetBytes[i] = (hv << 4) | lv;
    }

    uint8_t buf[288];
    for (int i = 0; i < pl; i++) buf[i] = prefix[i];

    for (int n = 0; n <= difficulty; n++) {
        int no = pl;
        int val = n;
        if (val == 0) { buf[no++] = '0'; }
        else {
            nb = 0;
            while (val > 0) { numBuf[nb++] = '0' + (val % 10); val /= 10; }
            for (int i = nb - 1; i >= 0; i--) buf[no++] = numBuf[i];
        }

        uint8_t hash[32];
        deepseek_hash(buf, no, hash);

        int match = 1;
        for (int i = 0; i < 32; i++) {
            if (hash[i] != targetBytes[i]) { match = 0; break; }
        }
        if (match) return n;
    }

    return -1;
}
