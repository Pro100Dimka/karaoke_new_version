#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct GraphStageInfo {
    std::string name;
    std::uint32_t bufferedFrames{0};
    std::uint32_t algorithmicLatencyFrames{0};
};
struct GraphSnapshot {
    std::vector<GraphStageInfo> stages;
    std::uint64_t poolBytes{0};
};
class GraphIntrospection {
  public:
    void set(GraphSnapshot snapshot);
    [[nodiscard]] GraphSnapshot snapshot() const;

  private:
    GraphSnapshot snapshot_{};
};
