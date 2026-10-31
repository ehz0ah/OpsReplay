/* Ordinary pathname normalization only; no privileged program or race fixture. */
#include <stdio.h>
#include <string.h>
#include "dl-path-normalize.h"

int main(void)
{
    const char *cases[][2] = {
        {"", ""}, {".", ""}, {"/", "/"}, {"///", "/"},
        {"/usr//lib/./ordinary", "/usr/lib/ordinary"},
        {"/usr/lib/../lib/ordinary/", "/usr/lib/ordinary"},
        {"ordinary/./file", "ordinary/file"},
        {"ordinary/../file", "file"}, {"../ordinary", "../ordinary"},
        {"ordinary/../../file", "../file"}, {"/../../ordinary", "/ordinary"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        char path[128];
        memset(path, 'j', sizeof(path));
        size_t original_length = strlen(cases[i][0]);
        if (original_length + 1 >= sizeof(path))
            return 1;
        strcpy(path, cases[i][0]);
        size_t result = _dl_normalize_path(path);
        if (strcmp(path, cases[i][1]) != 0 || result != strlen(cases[i][1])
            || path[original_length + 1] != 'j') {
            fprintf(stderr, "Ordinary pathname normalization failed at case %zu\n", i);
            return 1;
        }
    }
    puts("Ordinary pathname normalization passed");
    return 0;
}
