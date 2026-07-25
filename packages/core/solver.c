#include <stdint.h>

#define RATE 136

static const int RHO[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};

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

static inline uint64_t rotl64(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }

static void keccak_f1600(uint64_t s[25], int start, int end) {
    for (int r = start; r < end; r++) {
        uint64_t c0 = s[0]^s[5]^s[10]^s[15]^s[20];
        uint64_t c1 = s[1]^s[6]^s[11]^s[16]^s[21];
        uint64_t c2 = s[2]^s[7]^s[12]^s[17]^s[22];
        uint64_t c3 = s[3]^s[8]^s[13]^s[18]^s[23];
        uint64_t c4 = s[4]^s[9]^s[14]^s[19]^s[24];
        uint64_t d0 = c4 ^ rotl64(c1,1), d1 = c0 ^ rotl64(c2,1), d2 = c1 ^ rotl64(c3,1);
        uint64_t d3 = c2 ^ rotl64(c4,1), d4 = c3 ^ rotl64(c0,1);
        s[0]^=d0;s[1]^=d1;s[2]^=d2;s[3]^=d3;s[4]^=d4;
        s[5]^=d0;s[6]^=d1;s[7]^=d2;s[8]^=d3;s[9]^=d4;
        s[10]^=d0;s[11]^=d1;s[12]^=d2;s[13]^=d3;s[14]^=d4;
        s[15]^=d0;s[16]^=d1;s[17]^=d2;s[18]^=d3;s[19]^=d4;
        s[20]^=d0;s[21]^=d1;s[22]^=d2;s[23]^=d3;s[24]^=d4;
        uint64_t cur = s[1]; int x=1,y=0;
        for (int t=0; t<24; t++) {
            int nx=y, ny=(2*x+3*y)%5;
            uint64_t tmp = s[nx+5*ny];
            s[nx+5*ny] = rotl64(cur, RHO[x+5*y]);
            cur = tmp; x=nx; y=ny;
        }
        for (int y=0; y<5; y++) {
            int iy=y*5;
            uint64_t l0=s[iy],l1=s[iy+1],l2=s[iy+2],l3=s[iy+3],l4=s[iy+4];
            s[iy]=l0^(~l1&l2);s[iy+1]=l1^(~l2&l3);s[iy+2]=l2^(~l3&l4);
            s[iy+3]=l3^(~l4&l0);s[iy+4]=l4^(~l0&l1);
        }
        s[0] ^= RC[r];
    }
}

static void deepseek_hash(const uint8_t* input, int len, uint8_t out[32]) {
    uint64_t s[25] = {0};
    int k = (RATE - ((len + 2) % RATE)) % RATE;
    int padded = len + 2 + k;
    for (int off = 0; off < padded; off += RATE) {
        for (int j = 0; j < RATE; j++) {
            int pos = off + j;
            uint64_t byte = pos < len ? input[pos] : pos == len ? 0x06 : pos == padded-1 ? 0x80 : 0;
            s[j>>3] ^= byte << ((j&7)<<3);
        }
        keccak_f1600(s, 1, 24);
    }
    for (int i = 0; i < 32; i++) out[i] = (uint8_t)(s[i>>3] >> ((i&7)<<3));
}

__attribute__((export_name("solve_pow")))
int solve_pow(const uint8_t* salt, int saltLen, int64_t expireAt, int32_t difficulty, const uint8_t* target, int targetLen) {
    uint8_t prefix[256]; int pl = saltLen;
    for (int i = 0; i < saltLen; i++) prefix[i] = salt[i]; prefix[pl++] = '_';
    char digits[32]; int nb = 0; int64_t t = expireAt;
    if (t < 0) { prefix[pl++] = '-'; t = -t; }
    if (t == 0) { prefix[pl++] = '0'; }
    else { int ds = pl; while (t > 0) { digits[nb++] = '0' + (int)(t%10); t/=10; } while (nb>0) prefix[ds++] = digits[--nb]; pl = ds; }
    prefix[pl++] = '_';

    uint8_t targetBytes[32];
    for (int i = 0; i < 32; i++) {
        char hi = target[i*2], lo = target[i*2+1];
		int hiv = hi>='0'&&hi<='9'?hi-48:hi>='A'&&hi<='F'?hi-55:hi>='a'&&hi<='f'?hi-87:0;
		int lov = lo>='0'&&lo<='9'?lo-48:lo>='A'&&lo<='F'?lo-55:lo>='a'&&lo<='f'?lo-87:0;
        targetBytes[i] = (uint8_t)((hiv<<4) | lov);
    }

    uint8_t buf[288];
    for (int i = 0; i < pl; i++) buf[i] = prefix[i];

    for (int n = 0; n <= difficulty; n++) {
        int no = pl, val = n;
        if (val == 0) { buf[no++] = '0'; }
        else { nb = 0; do { digits[nb++] = '0'+(val%10); val/=10; } while (val>0); while (nb>0) buf[no++] = digits[--nb]; }

        uint8_t hash[32];
        deepseek_hash(buf, no, hash);

        uint8_t match = 1;
        for (int i = 0; match && i < 32; i++) if (hash[i] != targetBytes[i]) match = 0;
        if (match) return n;
    }
    return -1;
}
