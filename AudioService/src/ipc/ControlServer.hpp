#pragma once
#include <atomic>
#include <string>
class AudioService;
class ControlServer {
  public:
    explicit ControlServer(AudioService& service, std::string endpoint = {});
    ~ControlServer();
    void serve();
    void stop() noexcept;

  private:
    AudioService& service_;
    std::string endpoint_;
    std::atomic<bool> stop_{false};
#ifdef _WIN32
    void* stopEvent_{nullptr};
#endif
};
