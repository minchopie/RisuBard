#include <cstdlib>
#include <csignal>
#include <sys/prctl.h>
#include <unistd.h>

int llama_server(int argc, char ** argv);

int main(int argc, char ** argv) {
    // A killed app server must not leave an orphan holding the model and port.
    if (const char * owner = std::getenv("RISUBARD_PARENT_PID")) {
        char * end = nullptr;
        const long expected = std::strtol(owner, &end, 10);
        if (expected <= 1 || *end || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != expected) return 1;
    }
    return llama_server(argc, argv);
}
